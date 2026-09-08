package main

import (
	"encoding/binary"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type sourceProgramFixtureOutput struct {
	mu                           sync.Mutex
	audios, videos               int
	last, lastAudio, lastVideo   int64
	left                         int16
	pixel                        [4]byte
	audioGuard, videoGuard       sourceRenderGuard
	audioBorrowed, videoBorrowed []byte
	fail                         bool
	closed                       int
	hook                         func()
	observed                     chan struct{}
}

func (o *sourceProgramFixtureOutput) WriteProgramAudio(at int64, pcm []byte, g sourceRenderGuard) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed != 0 || o.fail || at < o.last || len(pcm) != 3840 || o.audios > 0 && at != o.lastAudio+960 {
		return errors.New("fixture audio scope")
	}
	o.audios++
	o.last, o.lastAudio = at, at
	o.left = int16(binary.LittleEndian.Uint16(pcm))
	o.audioGuard = g
	o.audioBorrowed = pcm
	if o.hook != nil {
		o.hook()
	}
	select {
	case o.observed <- struct{}{}:
	default:
	}
	return nil
}
func (o *sourceProgramFixtureOutput) WriteProgramVideo(at int64, revision uint64, pixels []byte, g sourceRenderGuard) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed != 0 || o.fail || at < o.last || revision < 1 || len(pixels) != 64*36*4 || o.videos > 0 && at <= o.lastVideo {
		return errors.New("fixture video scope")
	}
	o.videos++
	o.last, o.lastVideo = at, at
	o.pixel = [4]byte(pixels[:4])
	o.videoGuard = g
	o.videoBorrowed = pixels
	return nil
}
func (o *sourceProgramFixtureOutput) Close() { o.mu.Lock(); defer o.mu.Unlock(); o.closed++ }

func programClockFixture(t *testing.T, fps int) (*sourceProgramClock, *sourceProgramFixtureOutput, *time.Time) {
	t.Helper()
	now := time.Unix(1700000000, 0)
	o := &sourceProgramFixtureOutput{observed: make(chan struct{}, 1)}
	p, err := newSourceProgramClock(sourceProgramClockConfig{start: now, now: func() time.Time { return now }, framesPerSecond: fps, maxLagSamples: 4800,
		authorized: func() bool { return true }, revoked: make(chan struct{})}, audioMixFixture(t, 48000, 2), videoMixFixture(t, 2), o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p, o, &now
}

func TestSourceProgramRationalTimeline(t *testing.T) {
	for fps := 1; fps <= 60; fps++ {
		p, o, now := programClockFixture(t, fps)
		for i := 0; i < 1000; i++ {
			*now = p.cfg.start.Add(time.Duration(i) * 2 * time.Millisecond)
			if err := p.Step(); err != nil {
				t.Fatal(err)
			}
		}
		if o.audios != 100 || o.videos != fps*2 || o.lastAudio != 99*960 {
			t.Fatalf("rational schedule fps=%d audio=%d video=%d", fps, o.audios, o.videos)
		}
		if err := p.Step(); err != nil || o.audios != 100 || o.videos != fps*2 {
			t.Fatal("same-time step duplicated output")
		}
		for _, index := range []int64{int64(fps)*3600*24*365*3 + 1, int64(fps)*100000 + int64(fps) - 1} {
			at, ok := sourceProgramVideoTime(index, fps, 100)
			if !ok || at != 100+index*48000/int64(fps) {
				t.Fatal("long rational timeline drift")
			}
		}
		p.Close()
	}
	if _, ok := sourceProgramVideoTime(math.MaxInt64, 60, 0); ok {
		t.Fatal("video time overflow")
	}
}

func TestSourceProgramCombinesMediaAndPropagatesRevocation(t *testing.T) {
	p, o, now := programClockFixture(t, 30)
	a := audioMixInputFixture(t, p.audio)
	v := videoMixInputFixture(t, p.video, "camera")
	if err := a.WritePCM(48000, 2, 0, audioMixPCM(960, 1234, 2345)); err != nil {
		t.Fatal(err)
	}
	if err := v.WriteRGBA(64, 36, 0, solidVideoMix(64, 36, 200, 0, 0)); err != nil {
		t.Fatal(err)
	}
	setVideoMixScene(t, p.video, "single", []*sourceVideoMixInput{v}, nil)
	if err := p.Step(); err != nil {
		t.Fatal(err)
	}
	if o.left != 1234 || o.pixel != [4]byte{200, 0, 0, 255} || !o.audioGuard.Valid() || !o.videoGuard.Valid() {
		t.Fatal("program media/guard handoff")
	}
	ag, vg := o.audioGuard, o.videoGuard
	for _, b := range o.audioBorrowed {
		if b != 0 {
			t.Fatal("borrowed audio retained")
		}
	}
	for _, b := range o.videoBorrowed {
		if b != 0 {
			t.Fatal("borrowed video retained")
		}
	}
	a.Close()
	v.Close()
	if ag.Valid() || vg.Valid() {
		t.Fatal("queued output could not detect revocation")
	}
	*now = now.Add(40 * time.Millisecond)
	if err := p.Step(); err != nil {
		t.Fatal(err)
	}
	if o.left != 0 || o.pixel != [4]byte{9, 19, 31, 255} || o.audioGuard.count != 0 || o.videoGuard.count != 0 {
		t.Fatal("missing sources did not become silence/slate")
	}
}

func TestSourceProgramBoundsAndTerminalFailure(t *testing.T) {
	for _, mode := range []string{"lag", "rollback", "output", "writer"} {
		t.Run(mode, func(t *testing.T) {
			p, o, now := programClockFixture(t, 60)
			switch mode {
			case "lag":
				*now = now.Add(101 * time.Millisecond)
			case "rollback":
				*now = now.Add(-time.Nanosecond)
			case "output":
				o.fail = true
			case "writer":
				p.cfg.authorized = func() bool { return false }
			}
			if err := p.Step(); err == nil {
				t.Fatal("program failure ignored")
			}
			p.Close()
			if err := p.Step(); err == nil || o.closed != 1 || !p.audio.closed || !p.video.closed {
				t.Fatal("terminal cleanup/revival")
			}
		})
	}
	p, o, now := programClockFixture(t, 60)
	*now = now.Add(100 * time.Millisecond)
	if err := p.Step(); err != nil || o.audios+o.videos != 13 {
		t.Fatal("bounded catchup failed")
	}
}

func TestSourceProgramRechecksWriterBetweenHandoffs(t *testing.T) {
	p, o, _ := programClockFixture(t, 30)
	var allowed atomic.Bool
	allowed.Store(true)
	p.cfg.authorized = allowed.Load
	o.hook = func() { allowed.Store(false) }
	if err := p.Step(); err == nil || o.audios != 1 || o.videos != 0 || o.closed != 1 {
		t.Fatal("writer loss crossed next handoff")
	}
}

func TestSourceProgramUniqueSchedulingOwner(t *testing.T) {
	p, _, _ := programClockFixture(t, 30)
	if duplicate, err := newSourceProgramClock(p.cfg, p.audio, p.video, &sourceProgramFixtureOutput{}); err == nil || duplicate != nil {
		t.Fatal("second scheduling owner accepted")
	}
}

func TestSourceProgramConfigurationAndCursorFences(t *testing.T) {
	now := time.Unix(1700000000, 0)
	base := sourceProgramClockConfig{start: now, now: func() time.Time { return now }, framesPerSecond: 30, maxLagSamples: 4800,
		authorized: func() bool { return true }, revoked: make(chan struct{})}
	a, v := audioMixFixture(t, 1920, 1), videoMixFixture(t, 1)
	out := &sourceProgramFixtureOutput{}
	for _, mutate := range []func(*sourceProgramClockConfig){
		func(c *sourceProgramClockConfig) { c.start = time.Time{} },
		func(c *sourceProgramClockConfig) { c.now = nil },
		func(c *sourceProgramClockConfig) { c.now = func() time.Time { return now.Add(-time.Second) } },
		func(c *sourceProgramClockConfig) { c.framesPerSecond = 0 },
		func(c *sourceProgramClockConfig) { c.framesPerSecond = 61 },
		func(c *sourceProgramClockConfig) { c.maxLagSamples = 959 },
		func(c *sourceProgramClockConfig) { c.maxLagSamples = 4801 },
		func(c *sourceProgramClockConfig) { c.startSample = -1 },
		func(c *sourceProgramClockConfig) { c.startSample = math.MaxInt64 },
		func(c *sourceProgramClockConfig) { c.startSample = 1 },
		func(c *sourceProgramClockConfig) { c.authorized = nil },
		func(c *sourceProgramClockConfig) { c.authorized = func() bool { return false } },
		func(c *sourceProgramClockConfig) { c.revoked = nil },
		func(c *sourceProgramClockConfig) { ch := make(chan struct{}); close(ch); c.revoked = ch },
	} {
		cfg := base
		mutate(&cfg)
		if p, err := newSourceProgramClock(cfg, a, v, out); err == nil || p != nil {
			t.Fatal("invalid program config accepted")
		}
	}
	if a.programOwned || v.programOwned || out.closed != 0 {
		t.Fatal("denied constructor stole resources")
	}
	if p, err := newSourceProgramClock(base, a, v, nil); err == nil || p != nil {
		t.Fatal("missing output")
	}
	if err := a.Render(func(int64, []byte) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if p, err := newSourceProgramClock(base, a, v, out); err == nil || p != nil {
		t.Fatal("already consumed audio cursor adopted")
	}
}

func TestSourceProgramSteadyStepDoesNotAllocate(t *testing.T) {
	p, _, now := programClockFixture(t, 60)
	if allocations := testing.AllocsPerRun(100, func() {
		*now = now.Add(20 * time.Millisecond)
		if err := p.Step(); err != nil {
			panic(err)
		}
	}); allocations != 0 {
		t.Fatalf("steady program allocations: %.1f", allocations)
	}
}

func TestSourceProgramDeniedStartClosesOwnedStages(t *testing.T) {
	p, o, _ := programClockFixture(t, 30)
	p.cfg.authorized = func() bool { return false }
	if err := p.Start(); err == nil || !p.closed.Load() || !p.audio.closed || !p.video.closed || o.closed != 1 {
		t.Fatal("denied start retained program")
	}
}

func TestSourceProgramLiveTickerAndIdleRevoke(t *testing.T) {
	p, o, _ := programClockFixture(t, 30)
	p.cfg.start = time.Now()
	p.last = p.cfg.start
	p.cfg.now = time.Now
	revoked := make(chan struct{})
	p.cfg.revoked = revoked
	if err := p.Start(); err != nil {
		t.Fatal(err)
	}
	awaitSource(t, o.observed)
	if err := p.Start(); err == nil {
		t.Fatal("duplicate ticker")
	}
	close(revoked)
	awaitSource(t, p.done)
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed != 1 || o.audios < 1 {
		t.Fatal("live ticker lifecycle")
	}
}
