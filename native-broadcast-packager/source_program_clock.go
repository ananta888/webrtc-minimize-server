package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Borrows bytes for bounded, nonblocking handoff only, NEVER encoder I/O.
// Retained output must retain/recheck guard before writing; Close invalidates
// and wipes its queues. Writer policy remains separate from source guards.
type sourceProgramOutput interface {
	WriteProgramAudio(at int64, pcm []byte, guard sourceRenderGuard) error
	WriteProgramVideo(at int64, revision uint64, pixels []byte, guard sourceRenderGuard) error
	Close()
}

type sourceProgramClockConfig struct {
	start           time.Time
	now             func() time.Time
	startSample     int64
	framesPerSecond int
	maxLagSamples   int64
	authorized      func() bool
	revoked         <-chan struct{}
}

// Owns both fresh render cursors and their output lifecycle. It neither opens
// capture nor assigns publisher identity; the program owner supplies these.
type sourceProgramClock struct {
	mu                    sync.Mutex
	cfg                   sourceProgramClockConfig
	audio                 *sourceAudioMixer
	video                 *sourceVideoMixer
	output                sourceProgramOutput
	last                  time.Time
	nextAudio, videoIndex int64
	closed                atomic.Bool
	started               bool
	done                  chan struct{}
}

func newSourceProgramClock(cfg sourceProgramClockConfig, audio *sourceAudioMixer, video *sourceVideoMixer, output sourceProgramOutput) (*sourceProgramClock, error) {
	if cfg.start.IsZero() || cfg.now == nil || cfg.startSample < 0 || cfg.startSample > sourceAudioMixMaxTime-48000 ||
		cfg.framesPerSecond < 1 || cfg.framesPerSecond > 60 || cfg.maxLagSamples < 960 || cfg.maxLagSamples > 4800 ||
		cfg.authorized == nil || cfg.revoked == nil || audio == nil || video == nil || output == nil {
		return nil, errors.New("source program clock config")
	}
	p := &sourceProgramClock{cfg: cfg, audio: audio, video: video, output: output, last: cfg.start, nextAudio: cfg.startSample, done: make(chan struct{})}
	if !p.permitted() || cfg.now().Before(cfg.start) {
		return nil, errors.New("source program denied")
	}
	// Caller transfers exclusive scheduling ownership only on success. Sources
	// may already be attached, but previously rendered cursors cannot be adopted.
	audio.mu.Lock()
	defer audio.mu.Unlock()
	video.mu.Lock()
	defer video.mu.Unlock()
	if audio.closed || video.closed || audio.programOwned || video.programOwned || audio.cfg.startSample != cfg.startSample || video.cfg.startSample != cfg.startSample || audio.cursor != cfg.startSample || video.cursor != cfg.startSample || video.rendered {
		return nil, errors.New("source program cursor ownership")
	}
	audio.programOwned, video.programOwned = true, true
	return p, nil
}

func (p *sourceProgramClock) permitted() bool {
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

// Quotient/remainder arithmetic avoids both cumulative rounding drift and a
// multiplication overflow. Output is quantized to at most one 48-kHz sample.
func sourceProgramVideoTime(index int64, fps int, start int64) (int64, bool) {
	if index < 0 || fps < 1 || fps > 60 || start < 0 || start > sourceVideoMixMaxTime {
		return 0, false
	}
	whole := index / int64(fps)
	if whole > (sourceVideoMixMaxTime-start)/48000 {
		return 0, false
	}
	at := start + whole*48000 + (index%int64(fps))*48000/int64(fps)
	return at, at <= sourceVideoMixMaxTime
}

// Step is deterministic with an injected monotone clock. A delayed scheduler
// may catch up at most 100 ms / 16 handoffs; it never rebases or emits an
// unbounded old-media burst. Source-independent silence/slate uses normal time.
func (p *sourceProgramClock) Step() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permitted() {
		p.closeLocked()
		return errors.New("source program revoked")
	}
	now := p.cfg.now()
	if now.Before(p.cfg.start) || now.Before(p.last) {
		p.closeLocked()
		return errors.New("source program clock rollback")
	}
	p.last = now
	delta := sourceDurationSamples(now.Sub(p.cfg.start))
	if delta > sourceAudioMixMaxTime-p.cfg.startSample {
		p.closeLocked()
		return errors.New("source program time budget")
	}
	target := p.cfg.startSample + delta
	for count := 0; count < 16; count++ {
		videoAt, ok := sourceProgramVideoTime(p.videoIndex, p.cfg.framesPerSecond, p.cfg.startSample)
		if !ok {
			p.closeLocked()
			return errors.New("source program video time budget")
		}
		next := min(p.nextAudio, videoAt)
		if next > target {
			return nil
		}
		if target-next > p.cfg.maxLagSamples {
			p.closeLocked()
			return errors.New("source program scheduler lag")
		}
		if !p.permitted() {
			p.closeLocked()
			return errors.New("source program revoked")
		}
		var err error
		if p.nextAudio <= videoAt {
			err = p.audio.RenderGuarded(p.writeAudio)
			p.nextAudio += sourceAudioMixSamples
		} else {
			err = p.video.RenderGuarded(videoAt, p.writeVideo)
			p.videoIndex++
		}
		if err != nil {
			p.closeLocked()
			return errors.New("source program output failed")
		}
	}
	p.closeLocked()
	return errors.New("source program catchup budget")
}

func (p *sourceProgramClock) writeAudio(at int64, pcm []byte, guard sourceRenderGuard) error {
	if !p.permitted() || at != p.nextAudio {
		return errors.New("source program audio fence")
	}
	if !guard.Valid() {
		clear(pcm)
		guard = sourceRenderGuard{}
	}
	return p.output.WriteProgramAudio(at, pcm, guard)
}

func (p *sourceProgramClock) writeVideo(at int64, revision uint64, pixels []byte, guard sourceRenderGuard) error {
	if !p.permitted() {
		return errors.New("source program video fence")
	}
	if !guard.Valid() {
		fillSourceVideoSlate(pixels, p.video.cfg.width, 0, 0, p.video.cfg.width, p.video.cfg.height)
		guard = sourceRenderGuard{}
	}
	return p.output.WriteProgramVideo(at, revision, pixels, guard)
}

func (p *sourceProgramClock) Start() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permitted() {
		p.closeLocked()
		return errors.New("source program denied")
	}
	if p.started {
		return errors.New("source program already started or denied")
	}
	p.started = true
	go func() {
		defer p.Close()
		tick := time.NewTicker(2 * time.Millisecond)
		defer tick.Stop()
		if p.Step() != nil {
			return
		}
		for {
			select {
			case <-p.done:
				return
			case <-p.cfg.revoked:
				return
			case <-tick.C:
				if p.Step() != nil {
					return
				}
			}
		}
	}()
	return nil
}

func (p *sourceProgramClock) closeLocked() {
	if p.closed.Swap(true) {
		return
	}
	p.audio.Close()
	p.video.Close()
	p.output.Close()
	close(p.done)
}
func (p *sourceProgramClock) Close() { p.mu.Lock(); defer p.mu.Unlock(); p.closeLocked() }
