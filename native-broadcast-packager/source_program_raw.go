package main

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

type sourceProgramRawConfig struct {
	width, height, fps       int
	startSample              int64
	audioFrames, videoFrames int
	maxBytes                 int
	writeTimeout             time.Duration
	authorized               func() bool // Bounded/thread-safe; must not reenter this output.
	revoked                  <-chan struct{}
	// Bounded, non-reentrant process/output invalidation, not policy creation.
	// Must stop the encoder before closing its input pipes. Called exactly once.
	abort func()
}

type sourceProgramRawSlot struct {
	bytes []byte
	guard sourceRenderGuard
	state uint8 // 0 free, 1 queued, 2 borrowed by its only writer
}

type sourceProgramRawLane struct {
	mu       sync.Mutex
	owner    *sourceProgramRaw
	pipe     io.WriteCloser // owned; Close must interrupt a concurrent Write
	slots    []sourceProgramRawSlot
	ready    chan int
	video    bool
	index    int64
	revision uint64
	active   int
	since    time.Time
}

// Raw PCM16LE/RGBA only: never an IVF/Ogg/RTP adapter. One bounded queue and
// one independent writer per medium prevent pipe I/O under mixer locks.
type sourceProgramRaw struct {
	cfg      sourceProgramRawConfig
	audio    *sourceProgramRawLane
	video    *sourceProgramRawLane
	closed   atomic.Bool
	done     chan struct{}
	finished chan struct{} // queue/pipes only, not encoder process reaping
	workers  sync.WaitGroup
}

func newSourceProgramRaw(cfg sourceProgramRawConfig, audio, video io.WriteCloser) (*sourceProgramRaw, error) {
	if !validSourceVideoSize(cfg.width, cfg.height) || cfg.fps < 1 || cfg.fps > 60 ||
		cfg.startSample < 0 || cfg.startSample > sourceAudioMixMaxTime-48000 ||
		cfg.audioFrames < 2 || cfg.audioFrames > 16 || cfg.videoFrames < 2 || cfg.videoFrames > 8 ||
		cfg.maxBytes < 1 || cfg.maxBytes > 128*1024*1024 ||
		cfg.writeTimeout < 100*time.Millisecond || cfg.writeTimeout > 2*time.Second ||
		cfg.authorized == nil || cfg.revoked == nil || cfg.abort == nil || audio == nil || video == nil {
		return nil, errors.New("source raw output config")
	}
	bytes := cfg.audioFrames*3840 + cfg.videoFrames*cfg.width*cfg.height*4
	if bytes > cfg.maxBytes {
		return nil, errors.New("source raw output byte budget")
	}
	p := &sourceProgramRaw{cfg: cfg, done: make(chan struct{}), finished: make(chan struct{})}
	if !p.permitted() {
		return nil, errors.New("source raw output denied")
	}
	makeLane := func(pipe io.WriteCloser, count, size int, video bool) *sourceProgramRawLane {
		q := &sourceProgramRawLane{owner: p, pipe: pipe, slots: make([]sourceProgramRawSlot, count), ready: make(chan int, count), video: video, active: -1}
		for i := range q.slots {
			q.slots[i].bytes = make([]byte, size)
		}
		return q
	}
	p.audio = makeLane(audio, cfg.audioFrames, 3840, false)
	p.video = makeLane(video, cfg.videoFrames, cfg.width*cfg.height*4, true)
	p.workers.Add(4)
	go func() { defer p.workers.Done(); p.audio.run() }()
	go func() { defer p.workers.Done(); p.video.run() }()
	go func() { defer p.workers.Done(); p.watch() }()
	go func() {
		defer p.workers.Done()
		<-p.done
		p.cfg.abort()
		_ = audio.Close()
		_ = video.Close()
	}()
	go func() {
		p.workers.Wait()
		p.audio.wipe(false)
		p.video.wipe(false)
		close(p.finished)
	}()
	return p, nil
}

func (p *sourceProgramRaw) permitted() bool {
	if p.closed.Load() {
		return false
	}
	select {
	case <-p.cfg.revoked:
		return false
	default:
		return p.cfg.authorized()
	}
}

func (p *sourceProgramRaw) WriteProgramAudio(at int64, pcm []byte, guard sourceRenderGuard) error {
	return p.audio.enqueue(at, 0, pcm, guard)
}
func (p *sourceProgramRaw) WriteProgramVideo(at int64, revision uint64, pixels []byte, guard sourceRenderGuard) error {
	return p.video.enqueue(at, revision, pixels, guard)
}

func (q *sourceProgramRawLane) enqueue(at int64, revision uint64, data []byte, guard sourceRenderGuard) error {
	q.mu.Lock()
	err := q.enqueueLocked(at, revision, data, guard)
	q.mu.Unlock()
	if err != nil {
		q.owner.Close()
	}
	return err
}

func (q *sourceProgramRawLane) enqueueLocked(at int64, revision uint64, data []byte, guard sourceRenderGuard) error {
	p := q.owner
	expected, ok := p.cfg.startSample+q.index*960, q.index <= (sourceAudioMixMaxTime-p.cfg.startSample)/960
	if q.video {
		expected, ok = sourceProgramVideoTime(q.index, p.cfg.fps, p.cfg.startSample)
		ok = ok && revision >= 1 && revision <= 9007199254740991 && revision >= q.revision
	}
	if !p.permitted() || !ok || at != expected || len(data) != len(q.slots[0].bytes) {
		return errors.New("source raw output sequence or scope")
	}
	for i := range q.slots {
		s := &q.slots[i]
		if s.state != 0 {
			continue
		}
		copy(s.bytes, data)
		s.guard, s.state = guard, 1
		q.sanitize(s)
		q.index++
		q.revision = revision
		q.ready <- i // fixed slot ownership proves a channel cell is available
		return nil
	}
	return errors.New("source raw output queue budget")
}

func (q *sourceProgramRawLane) sanitize(s *sourceProgramRawSlot) {
	if s.guard.Valid() {
		return
	}
	if q.video {
		c := q.owner.cfg
		fillSourceVideoSlate(s.bytes, c.width, 0, 0, c.width, c.height)
	} else {
		clear(s.bytes)
	}
	s.guard = sourceRenderGuard{}
}

func (q *sourceProgramRawLane) run() {
	for {
		select {
		case <-q.owner.done:
			return
		case i := <-q.ready:
			q.mu.Lock()
			s := &q.slots[i]
			if q.owner.closed.Load() || s.state != 1 {
				q.mu.Unlock()
				return
			}
			q.sanitize(s)
			s.state, q.active, q.since = 2, i, time.Now()
			q.mu.Unlock()
			err := q.write(s)
			q.mu.Lock()
			clear(s.bytes)
			s.guard, s.state, q.active = sourceRenderGuard{}, 0, -1
			q.mu.Unlock()
			if err != nil {
				q.owner.Close()
				return
			}
		}
	}
}

func (q *sourceProgramRawLane) write(s *sourceProgramRawSlot) error {
	remaining := s.bytes
	for len(remaining) != 0 {
		if !q.owner.permitted() || !s.guard.Valid() {
			return errors.New("source raw write revoked")
		}
		n, err := q.pipe.Write(remaining)
		if err != nil || n <= 0 || n > len(remaining) {
			return errors.New("source raw write failed")
		}
		remaining = remaining[n:]
	}
	if !q.owner.permitted() || !s.guard.Valid() {
		return errors.New("source raw write revoked")
	}
	return nil
}

// Does not mutate bytes borrowed by a writer: Close interrupts that writer;
// only the writer (or the final worker barrier) may wipe its active buffer.
func (q *sourceProgramRawLane) wipe(queuedOnly bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i := range q.slots {
		s := &q.slots[i]
		if queuedOnly && s.state == 2 {
			continue
		}
		clear(s.bytes)
		s.guard, s.state = sourceRenderGuard{}, 0
		if !queuedOnly {
			s.bytes = nil
		}
	}
}

func (q *sourceProgramRawLane) inspect(now time.Time) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i := range q.slots {
		s := &q.slots[i]
		if s.state == 1 {
			q.sanitize(s)
		}
	}
	return q.active < 0 || now.Sub(q.since) <= q.owner.cfg.writeTimeout && q.slots[q.active].guard.Valid()
}

func (p *sourceProgramRaw) watch() {
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-p.cfg.revoked:
			p.Close()
			return
		case now := <-tick.C:
			if !p.permitted() || !p.audio.inspect(now) || !p.video.inspect(now) {
				p.Close()
				return
			}
		}
	}
}

func (p *sourceProgramRaw) Close() {
	if p.closed.Swap(true) {
		return
	}
	p.audio.wipe(true)
	p.video.wipe(true)
	close(p.done)
}
