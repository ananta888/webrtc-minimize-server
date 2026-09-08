package main

import (
	"bytes"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Write borrows until released/closed. It deliberately blocks without owning
// an application mutex, just like an OS pipe whose reader stopped consuming.
type sourceRawTestPipe struct {
	entered chan []byte
	release chan struct{}
	closed  chan struct{}
	once    sync.Once
	limit   int
}

func newSourceRawTestPipe() *sourceRawTestPipe {
	return &sourceRawTestPipe{entered: make(chan []byte, 32), release: make(chan struct{}, 32), closed: make(chan struct{})}
}
func (w *sourceRawTestPipe) Write(b []byte) (int, error) {
	w.entered <- b
	select {
	case <-w.closed:
		return 0, io.ErrClosedPipe
	case <-w.release:
		if w.limit > 0 {
			return min(w.limit, len(b)), nil
		}
		return len(b), nil
	}
}
func (w *sourceRawTestPipe) Close() error { w.once.Do(func() { close(w.closed) }); return nil }

// Anonymous-pipe deadline support varies by OS. Bound actual reads through
// owned reader cancellation instead of assuming SetReadDeadline is portable.
func sourceRawRead(t *testing.T, reader *os.File, size int) []byte {
	t.Helper()
	type result struct {
		data []byte
		err  error
	}
	resultC := make(chan result, 1)
	go func() { b := make([]byte, size); _, err := io.ReadFull(reader, b); resultC <- result{b, err} }()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case r := <-resultC:
		if r.err != nil {
			t.Fatal("raw pipe read failed")
		}
		return r.data
	case <-timer.C:
		_ = reader.Close()
		awaitSource(t, resultC)
		t.Fatal("raw pipe read deadline")
		return nil
	}
}

func sourceRawFixture(t *testing.T, options ...func(*sourceProgramRawConfig)) (*sourceProgramRaw, *sourceRawTestPipe, *sourceRawTestPipe, *atomic.Int32) {
	t.Helper()
	a, v := newSourceRawTestPipe(), newSourceRawTestPipe()
	aborts := &atomic.Int32{}
	cfg := sourceProgramRawConfig{width: 64, height: 36, fps: 30,
		audioFrames: 4, videoFrames: 4, maxBytes: 1024 * 1024, writeTimeout: 2 * time.Second,
		authorized: func() bool { return true }, revoked: make(chan struct{}), abort: func() { aborts.Add(1) }}
	for _, option := range options {
		option(&cfg)
	}
	p, err := newSourceProgramRaw(cfg, a, v)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); awaitSource(t, p.finished) })
	return p, a, v, aborts
}

func TestSourceRawQueuedRevokeReplacesAudioAndVideo(t *testing.T) {
	p, a, v, _ := sourceRawFixture(t)
	pcm := bytes.Repeat([]byte{7}, 3840)
	pixels := solidVideoMix(64, 36, 200, 0, 0)
	if err := p.WriteProgramAudio(0, pcm, sourceRenderGuard{}); err != nil {
		t.Fatal(err)
	}
	if err := p.WriteProgramVideo(0, 1, pixels, sourceRenderGuard{}); err != nil {
		t.Fatal(err)
	}
	activeAudio, activeVideo := awaitSource(t, a.entered), awaitSource(t, v.entered)
	f := &sourceRenderFence{allowed: func() bool { return true }}
	var guard sourceRenderGuard
	guard.add(f)
	if err := p.WriteProgramAudio(960, pcm, guard); err != nil {
		t.Fatal(err)
	}
	if err := p.WriteProgramVideo(1600, 2, pixels, guard); err != nil {
		t.Fatal(err)
	}
	clear(pcm)
	clear(pixels) // queues own their copies
	f.closed.Store(true)
	// The same sweep used by the live watchdog must sanitize queued buffers,
	// without overwriting bytes concurrently borrowed by an active writer.
	if !p.audio.inspect(time.Now()) || !p.video.inspect(time.Now()) {
		t.Fatal("empty active guard denied")
	}
	if activeAudio[0] != 7 || activeVideo[0] != 200 {
		t.Fatal("active write was mutated")
	}
	p.audio.mu.Lock()
	for i := range p.audio.slots {
		if s := &p.audio.slots[i]; s.state == 1 && (s.guard.count != 0 || !bytes.Equal(s.bytes, make([]byte, 3840))) {
			t.Error("queued PCM retained")
		}
	}
	p.audio.mu.Unlock()
	a.release <- struct{}{}
	v.release <- struct{}{}
	nextAudio, nextVideo := awaitSource(t, a.entered), awaitSource(t, v.entered)
	if !bytes.Equal(nextAudio, make([]byte, 3840)) {
		t.Fatal("revoked PCM reached pipe")
	}
	for i := 0; i < len(nextVideo); i += 4 {
		if [4]byte(nextVideo[i:i+4]) != [4]byte{9, 19, 31, 255} {
			t.Fatal("revoked pixel reached pipe")
		}
	}
	if p.closed.Load() {
		t.Fatal("queued source revoke unnecessarily stopped program")
	}
	p.Close()
	awaitSource(t, p.finished)
	for _, b := range [][]byte{activeAudio, activeVideo, nextAudio, nextVideo} {
		for _, x := range b {
			if x != 0 {
				t.Fatal("retained raw buffer after writers exited")
			}
		}
	}
}

func TestSourceRawActiveRevokeAbortsWithoutMutatingBorrowedBytes(t *testing.T) {
	p, a, _, aborts := sourceRawFixture(t)
	f := &sourceRenderFence{allowed: func() bool { return true }}
	var g sourceRenderGuard
	g.add(f)
	if err := p.WriteProgramAudio(0, bytes.Repeat([]byte{9}, 3840), g); err != nil {
		t.Fatal(err)
	}
	borrowed := awaitSource(t, a.entered)
	f.closed.Store(true)
	awaitSource(t, p.finished) // real watchdog interrupts a blocked Write
	if aborts.Load() != 1 || !p.closed.Load() {
		t.Fatal("active source revoke did not invalidate encoder")
	}
	for _, b := range borrowed {
		if b != 0 {
			t.Fatal("active buffer not wiped after writer exit")
		}
	}
	p.Close()
	if aborts.Load() != 1 {
		t.Fatal("duplicate encoder abort")
	}
}

func TestSourceRawShortWritesAndSequence(t *testing.T) {
	p, a, _, _ := sourceRawFixture(t)
	a.limit = 1000
	if err := p.WriteProgramAudio(0, make([]byte, 3840), sourceRenderGuard{}); err != nil {
		t.Fatal(err)
	}
	for _, length := range []int{3840, 2840, 1840, 840} {
		if b := awaitSource(t, a.entered); len(b) != length {
			t.Fatal("partial raw frame rebased")
		}
		a.release <- struct{}{}
	}
	if err := p.WriteProgramAudio(960, make([]byte, 3840), sourceRenderGuard{}); err != nil {
		t.Fatal(err)
	}
	if b := awaitSource(t, a.entered); len(b) != 3840 {
		t.Fatal("next audio block lost")
	}
	if err := p.WriteProgramAudio(960, make([]byte, 3840), sourceRenderGuard{}); err == nil {
		t.Fatal("duplicate timestamp accepted")
	}
	awaitSource(t, p.finished)
}

func TestSourceRawSequenceAndQueueDenialsAreTerminal(t *testing.T) {
	for _, mode := range []string{"audio-time", "audio-size", "video-time", "video-size", "revision-zero", "revision-overflow", "revision-rollback", "queue-full"} {
		t.Run(mode, func(t *testing.T) {
			p, a, _, aborts := sourceRawFixture(t)
			var err error
			switch mode {
			case "audio-time":
				err = p.WriteProgramAudio(1, make([]byte, 3840), sourceRenderGuard{})
			case "audio-size":
				err = p.WriteProgramAudio(0, make([]byte, 3839), sourceRenderGuard{})
			case "video-time":
				err = p.WriteProgramVideo(1, 1, make([]byte, 64*36*4), sourceRenderGuard{})
			case "video-size":
				err = p.WriteProgramVideo(0, 1, nil, sourceRenderGuard{})
			case "revision-zero":
				err = p.WriteProgramVideo(0, 0, make([]byte, 64*36*4), sourceRenderGuard{})
			case "revision-overflow":
				err = p.WriteProgramVideo(0, 9007199254740992, make([]byte, 64*36*4), sourceRenderGuard{})
			case "revision-rollback":
				if e := p.WriteProgramVideo(0, 2, make([]byte, 64*36*4), sourceRenderGuard{}); e != nil {
					t.Fatal(e)
				}
				err = p.WriteProgramVideo(1600, 1, make([]byte, 64*36*4), sourceRenderGuard{})
			case "queue-full":
				for i := 0; i < 4; i++ {
					if e := p.WriteProgramAudio(int64(i*960), make([]byte, 3840), sourceRenderGuard{}); e != nil {
						t.Fatal(e)
					}
					if i == 0 {
						awaitSource(t, a.entered)
					}
				}
				err = p.WriteProgramAudio(4*960, make([]byte, 3840), sourceRenderGuard{})
			}
			if err == nil {
				t.Fatal("invalid raw write accepted")
			}
			awaitSource(t, p.finished)
			if aborts.Load() != 1 {
				t.Fatal("missing terminal encoder abort")
			}
		})
	}
}

func TestSourceRawRealPipesWriterRevocationAndIndependence(t *testing.T) {
	ar, aw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer ar.Close()
	vr, vw, err := os.Pipe()
	if err != nil {
		aw.Close()
		t.Fatal(err)
	}
	defer vr.Close()
	stop := make(chan struct{})
	var aborts atomic.Int32
	p, err := newSourceProgramRaw(sourceProgramRawConfig{width: 1920, height: 1080, fps: 30, audioFrames: 2, videoFrames: 2, maxBytes: 32 * 1024 * 1024,
		writeTimeout: time.Second, authorized: func() bool { return true }, revoked: stop, abort: func() { aborts.Add(1) }}, aw, vw)
	if err != nil {
		aw.Close()
		vw.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); awaitSource(t, p.finished) })
	// No video reader: one full-HD frame exceeds the real OS pipe capacity.
	if err = p.WriteProgramVideo(0, 1, make([]byte, 1920*1080*4), sourceRenderGuard{}); err != nil {
		t.Fatal(err)
	}
	if err = p.WriteProgramAudio(0, bytes.Repeat([]byte{11}, 3840), sourceRenderGuard{}); err != nil {
		t.Fatal(err)
	}
	pcm := sourceRawRead(t, ar, 3840)
	if !bytes.Equal(pcm, bytes.Repeat([]byte{11}, 3840)) {
		t.Fatal("raw PCM changed")
	}
	close(stop)
	awaitSource(t, p.finished)
	if aborts.Load() != 1 {
		t.Fatal("idle writer revoke ignored")
	}
}

func TestSourceRawWriterLossAndStallTerminateWhileIdle(t *testing.T) {
	for _, mode := range []string{"policy", "signal", "stall", "pipe-error", "partial-revoke"} {
		t.Run(mode, func(t *testing.T) {
			var allowed atomic.Bool
			allowed.Store(true)
			stop := make(chan struct{})
			p, a, _, aborts := sourceRawFixture(t, func(c *sourceProgramRawConfig) {
				c.authorized = allowed.Load
				c.revoked = stop
				c.writeTimeout = 100 * time.Millisecond
			})
			f := &sourceRenderFence{allowed: func() bool { return true }}
			var g sourceRenderGuard
			g.add(f)
			if mode == "partial-revoke" {
				a.limit = 1000
			}
			if err := p.WriteProgramAudio(0, make([]byte, 3840), g); err != nil {
				t.Fatal(err)
			}
			awaitSource(t, a.entered)
			switch mode {
			case "policy":
				allowed.Store(false)
			case "signal":
				close(stop)
			case "pipe-error":
				a.Close()
			case "partial-revoke":
				a.release <- struct{}{}
				if b := awaitSource(t, a.entered); len(b) != 2840 {
					t.Fatal("partial fixture did not advance")
				}
				f.closed.Store(true)
			}
			awaitSource(t, p.finished)
			if aborts.Load() != 1 {
				t.Fatal("lost writer did not invalidate encoder")
			}
			if err := p.WriteProgramAudio(960, make([]byte, 3840), sourceRenderGuard{}); err == nil {
				t.Fatal("writer revived")
			}
		})
	}
}

func TestSourceRawAdmissionBeforeAllocationOrOwnership(t *testing.T) {
	base := sourceProgramRawConfig{width: 64, height: 36, fps: 30, audioFrames: 2, videoFrames: 2, maxBytes: 2*3840 + 2*64*36*4,
		writeTimeout: time.Second, authorized: func() bool { return true }, revoked: make(chan struct{}), abort: func() { t.Error("denied constructor stole encoder") }}
	for _, change := range []func(*sourceProgramRawConfig){
		func(c *sourceProgramRawConfig) { c.width = 0 }, func(c *sourceProgramRawConfig) { c.height = 1082 },
		func(c *sourceProgramRawConfig) { c.width = 63 }, func(c *sourceProgramRawConfig) { c.fps = 0 }, func(c *sourceProgramRawConfig) { c.fps = 61 },
		func(c *sourceProgramRawConfig) { c.startSample = -1 }, func(c *sourceProgramRawConfig) { c.startSample = sourceAudioMixMaxTime },
		func(c *sourceProgramRawConfig) { c.audioFrames = 1 }, func(c *sourceProgramRawConfig) { c.audioFrames = 17 },
		func(c *sourceProgramRawConfig) { c.videoFrames = 1 }, func(c *sourceProgramRawConfig) { c.videoFrames = 9 },
		func(c *sourceProgramRawConfig) { c.maxBytes-- }, func(c *sourceProgramRawConfig) { c.maxBytes = 128*1024*1024 + 1 },
		func(c *sourceProgramRawConfig) { c.writeTimeout = 99 * time.Millisecond }, func(c *sourceProgramRawConfig) { c.writeTimeout = 3 * time.Second },
		func(c *sourceProgramRawConfig) { c.authorized = nil }, func(c *sourceProgramRawConfig) { c.authorized = func() bool { return false } },
		func(c *sourceProgramRawConfig) { c.revoked = nil }, func(c *sourceProgramRawConfig) { ch := make(chan struct{}); close(ch); c.revoked = ch },
		func(c *sourceProgramRawConfig) { c.abort = nil },
	} {
		cfg := base
		change(&cfg)
		a, v := newSourceRawTestPipe(), newSourceRawTestPipe()
		if p, err := newSourceProgramRaw(cfg, a, v); err == nil || p != nil {
			if p != nil {
				p.Close()
				awaitSource(t, p.finished)
			}
			t.Fatal("invalid raw configuration admitted")
		}
		select {
		case <-a.closed:
			t.Fatal("denied constructor closed caller pipe")
		default:
		}
		select {
		case <-v.closed:
			t.Fatal("denied constructor closed caller pipe")
		default:
		}
		a.Close()
		v.Close()
	}
	if p, err := newSourceProgramRaw(base, nil, newSourceRawTestPipe()); err == nil || p != nil {
		t.Fatal("missing pipe accepted")
	}
}

func TestSourceRawProgramClockFeedsBothMixersIntoRealPipes(t *testing.T) {
	p, _, now := programClockFixture(t, 30)
	ar, aw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer ar.Close()
	vr, vw, err := os.Pipe()
	if err != nil {
		aw.Close()
		t.Fatal(err)
	}
	defer vr.Close()
	raw, err := newSourceProgramRaw(sourceProgramRawConfig{width: 64, height: 36, fps: 30, audioFrames: 4, videoFrames: 4, maxBytes: 1024 * 1024,
		writeTimeout: time.Second, authorized: func() bool { return true }, revoked: make(chan struct{}), abort: func() {}}, aw, vw)
	if err != nil {
		aw.Close()
		vw.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { raw.Close(); awaitSource(t, raw.finished) })
	p.output = raw
	a := audioMixInputFixture(t, p.audio)
	v := videoMixInputFixture(t, p.video, "camera")
	pcm := audioMixPCM(960, 1234, 2345)
	pixels := solidVideoMix(64, 36, 200, 0, 0)
	if err = a.WritePCM(48000, 2, 0, pcm); err != nil {
		t.Fatal(err)
	}
	if err = v.WriteRGBA(64, 36, 0, pixels); err != nil {
		t.Fatal(err)
	}
	setVideoMixScene(t, p.video, "single", []*sourceVideoMixInput{v}, nil)
	read := func(r *os.File, size int) []byte {
		return sourceRawRead(t, r, size)
	}
	if err = p.Step(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(read(ar, len(pcm)), pcm) || !bytes.Equal(read(vr, len(pixels)), pixels) {
		t.Fatal("raw program mix changed")
	}
	// Wait for writer return before removing sources: this case exercises
	// normal source removal, distinct from the explicit in-flight abort test.
	deadline := time.Now().Add(time.Second)
	for {
		raw.audio.mu.Lock()
		idleAudio := raw.audio.active < 0
		raw.audio.mu.Unlock()
		raw.video.mu.Lock()
		idleVideo := raw.video.active < 0
		raw.video.mu.Unlock()
		if idleAudio && idleVideo {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("raw writer return deadline")
		}
		time.Sleep(time.Millisecond)
	}
	a.Close()
	v.Close()
	*now = now.Add(40 * time.Millisecond)
	if err = p.Step(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(read(ar, 2*3840), make([]byte, 2*3840)) {
		t.Fatal("empty raw program not silent")
	}
	slate := make([]byte, len(pixels))
	fillSourceVideoSlate(slate, 64, 0, 0, 64, 36)
	if !bytes.Equal(read(vr, len(slate)), slate) {
		t.Fatal("empty raw program retained image")
	}
	p.Close()
	awaitSource(t, raw.finished)
}
