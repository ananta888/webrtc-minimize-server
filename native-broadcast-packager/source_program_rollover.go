package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

type sourceRolloverEncoder interface {
	sourceGenerationOutput
	CanRollover() bool
	CurrentReady() bool
	StopSignal() <-chan struct{}
}

type sourceRolloverFactory func(sourceProgramEncoderConfig) (sourceRolloverEncoder, error)

// The program owns sources/mixers; this owner owns only successive encoders.
// No source or writer permission can be created or prolonged by a replacement.
type sourceProgramRollover struct {
	mu                             sync.Mutex
	cfg                            sourceProgramEncoderConfig
	create                         sourceRolloverFactory
	current                        sourceRolloverEncoder
	accept                         bool
	base                           int64 // -1 until a common whole-second audio/video boundary
	audioIndex, videoIndex         int64
	videoRevision                  uint64
	epoch                          sourceHLSEpoch
	closed                         atomic.Bool
	done, finished, ready, changes chan struct{}
	firstReady                     sync.Once
	observedReady                  bool
}

func newSourceProgramRollover(c sourceProgramEncoderConfig) (*sourceProgramRollover, error) {
	return newSourceProgramRolloverWithFactory(c, func(cfg sourceProgramEncoderConfig) (sourceRolloverEncoder, error) {
		out, err := newSourceProgramEncoder(cfg)
		if err != nil {
			return nil, err
		}
		return out, nil
	})
}

func newSourceProgramRolloverWithFactory(c sourceProgramEncoderConfig, create sourceRolloverFactory) (*sourceProgramRollover, error) {
	if !validSourceEncoderConfig(c) || c.startSample != 0 || c.hlsEpoch != 0 || create == nil {
		return nil, errors.New("source rollover config")
	}
	p := &sourceProgramRollover{cfg: c, create: create, base: -1, done: make(chan struct{}), finished: make(chan struct{}),
		ready: make(chan struct{}), changes: make(chan struct{}, 1)}
	p.cfg.profile.Renditions = append([]assignmentRendition(nil), c.profile.Renditions...)
	if !p.permitted() {
		return nil, errors.New("source rollover denied")
	}
	// Preserve initial admission's synchronous failure before any ready receipt.
	out, err := create(p.encoderConfig(0))
	if err != nil || out == nil {
		p.Close()
		if out != nil {
			out.Close()
			<-out.Finished()
		}
		return nil, errors.New("source rollover initial encoder")
	}
	if out.Finished() == nil || out.ReadySignal() == nil || out.StopSignal() == nil {
		out.Close()
		p.Close()
		<-out.Finished()
		return nil, errors.New("source rollover encoder lifecycle")
	}
	p.current, p.accept = out, true
	if !p.permitted() {
		p.Close()
		<-out.Finished()
		return nil, errors.New("source rollover initial revoked")
	}
	go p.run(out)
	return p, nil
}

func (p *sourceProgramRollover) encoderConfig(epoch sourceHLSEpoch) sourceProgramEncoderConfig {
	c := p.cfg
	c.authorized, c.revoked, c.hlsEpoch = p.permitted, p.done, epoch
	return c
}

func (p *sourceProgramRollover) permitted() bool {
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

func (p *sourceProgramRollover) ReadySignal() <-chan struct{}  { return p.ready }
func (p *sourceProgramRollover) Finished() <-chan struct{}     { return p.finished }
func (p *sourceProgramRollover) StateChanges() <-chan struct{} { return p.changes }

func (p *sourceProgramRollover) CurrentReady() bool {
	_, ready := p.OutputState()
	return ready
}

func (p *sourceProgramRollover) OutputState() (sourceHLSEpoch, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.epoch, p.permitted() && p.accept && p.base >= 0 && p.current != nil && p.current.CurrentReady()
}

func (p *sourceProgramRollover) Close() {
	if !p.closed.Swap(true) {
		close(p.done)
	}
	p.mu.Lock()
	out := p.current
	p.accept = false
	p.mu.Unlock()
	if out != nil {
		out.Close()
	} // Nonblocking lifecycle fence, not process I/O.
}

func (p *sourceProgramRollover) WriteProgramAudio(at int64, pcm []byte, guard sourceRenderGuard) error {
	return p.write(at, 0, pcm, guard, false)
}
func (p *sourceProgramRollover) WriteProgramVideo(at int64, revision uint64, pixels []byte, guard sourceRenderGuard) error {
	return p.write(at, revision, pixels, guard, true)
}

func (p *sourceProgramRollover) write(at int64, revision uint64, data []byte, guard sourceRenderGuard, video bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	expected, valid := p.audioIndex*960, p.audioIndex <= sourceAudioMixMaxTime/960
	size := 3840
	if video {
		expected, valid = sourceProgramVideoTime(p.videoIndex, p.cfg.fps, 0)
		valid = valid && revision >= 1 && revision >= p.videoRevision && revision <= sourceVideoSceneMaxRevision
		size = p.cfg.width * p.cfg.height * 4
	}
	if !p.permitted() || !valid || at != expected || len(data) != size || !sourceEncoderGuardShape(guard) {
		if !p.closed.Swap(true) {
			close(p.done)
		}
		p.accept = false
		if p.current != nil {
			p.current.Close()
		}
		return errors.New("source rollover input or writer denied")
	}
	if video {
		p.videoIndex++
		p.videoRevision = revision
	} else {
		p.audioIndex++
	}
	// Scheduler cursors continue while the old process drains and a new one is
	// constructed. Borrowed bytes are never retained or placed in a retry queue.
	if !p.accept || p.current == nil {
		return nil
	}
	if p.base < 0 {
		if video || at%48000 != 0 {
			return nil
		}
		p.base = at
	}
	var err error
	if video {
		err = p.current.WriteProgramVideo(at-p.base, revision, data, guard)
	} else {
		err = p.current.WriteProgramAudio(at-p.base, data, guard)
	}
	if err != nil {
		p.accept = false
		p.current.Close()
		// Only the fully reaped encoder's immutable cause may decide recovery.
		// Returning an error here would prematurely destroy the other sources.
	}
	return nil
}

func (p *sourceProgramRollover) observe(ready bool) {
	if ready {
		p.firstReady.Do(func() { close(p.ready) })
	}
	if ready != p.observedReady {
		p.observedReady = ready
		select {
		case p.changes <- struct{}{}:
		default:
		}
	}
}

func (p *sourceProgramRollover) run(out sourceRolloverEncoder) {
	defer func() {
		p.Close()
		out.Close()
		<-out.Finished()
		p.observe(false)
		close(p.finished) // Never claim ownership released while a child survives.
	}()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	started := time.Now()
	var budget sourceRolloverBudget
	for {
		select {
		case <-p.done:
			return
		case <-p.cfg.revoked:
			return
		case <-ticker.C:
			if !p.permitted() {
				return
			}
		}
		ready := p.CurrentReady()
		p.observe(ready)
		if ready {
			started = time.Now()
		}
		if time.Since(started) > 20*time.Second {
			return
		}
		p.mu.Lock()
		accept := p.accept
		p.mu.Unlock()
		select {
		case <-out.StopSignal():
			accept = false
		default:
		}
		if accept {
			continue
		}
		p.mu.Lock()
		p.accept = false
		p.mu.Unlock()
		p.observe(false)
		out.Close()
		if !p.drain(out) || !out.CanRollover() || !p.permitted() {
			return
		}
		p.mu.Lock()
		p.current = nil
		p.mu.Unlock()
		delay, ok := budget.reserve(time.Now())
		if !ok {
			return
		}
		timer := time.NewTimer(delay)
		select {
		case <-p.done:
			timer.Stop()
			return
		case <-p.cfg.revoked:
			timer.Stop()
			return
		case <-timer.C:
		}
		if !p.permitted() || p.epoch+1 >= sourceHLSEpochLimit {
			return
		}
		next, err := p.construct(p.epoch + 1)
		if err != nil {
			return
		}
		out = next
		p.mu.Lock()
		p.current, p.accept, p.base = out, true, -1
		p.epoch++
		p.mu.Unlock()
		started = time.Now()
	}
}

// Deadlines stop further work but do not pretend that unreaped ownership is
// free. A late constructor/cleanup stays quarantined until it actually ends.
func (p *sourceProgramRollover) drain(out sourceRolloverEncoder) bool {
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-out.Finished():
		return p.permitted()
	case <-p.done:
	case <-p.cfg.revoked:
	case <-timer.C:
	}
	p.Close()
	<-out.Finished()
	return false
}

func (p *sourceProgramRollover) construct(epoch sourceHLSEpoch) (sourceRolloverEncoder, error) {
	type result struct {
		out sourceRolloverEncoder
		err error
	}
	results := make(chan result, 1)
	go func() { out, err := p.create(p.encoderConfig(epoch)); results <- result{out, err} }()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var value result
	select {
	case value = <-results:
	case <-p.done:
		value = <-results
	case <-p.cfg.revoked:
		p.Close()
		value = <-results
	case <-timer.C:
		p.Close()
		value = <-results
	}
	if value.err != nil || value.out == nil || !p.permitted() || value.out.ReadySignal() == nil || value.out.StopSignal() == nil || value.out.Finished() == nil {
		if value.out != nil {
			value.out.Close()
			<-value.out.Finished()
		}
		return nil, errors.New("source rollover construction failed or revoked")
	}
	return value.out, nil
}
