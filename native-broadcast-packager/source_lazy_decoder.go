package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// One startup worker and at most one reserved encoded warmup frame. Network
// callbacks never spawn/wait for a process. Output callbacks must not reenter.
type sourceLazyDecoder struct {
	*sourceMediaClock
	mu                         sync.Mutex
	closed                     atomic.Bool
	codec                      string
	allowed                    func() bool
	revoked                    <-chan struct{}
	prepare                    func() (*sourcePendingDecoder, error)
	outputClose                func()
	request                    func() bool
	pending                    *sourcePendingDecoder
	decoder                    sourceDecoderHandle
	frame                      []byte
	timestamp, last            uint32
	observed, missing, needKey bool
	start                      chan struct{}
	done, finished             chan struct{}
}

func newSourceLazyVideoDecoder(cfg sourceVideoDecodeConfig, clock *sourceMediaClock, output sourceVideoOutput) (*sourceLazyDecoder, error) {
	if !validSourceVideoDecodeConfig(cfg, output) || clock == nil || clock.adaptive {
		return nil, errors.New("lazy source video config")
	}
	l := newSourceLazyState("video/vp8", clock, cfg.budget, cfg.authorized, cfg.revoked, output.Close)
	if !l.permitted() {
		return nil, errors.New("lazy source video denied")
	}
	cfg.authorized = l.permitted
	l.prepare = func() (*sourcePendingDecoder, error) { return prepareSourceVideoDecoder(cfg, output) }
	go l.run()
	return l, nil
}

func newSourceLazyAudioDecoder(cfg sourceAudioDecodeConfig, clock *sourceMediaClock, output sourceAudioOutput) (*sourceLazyDecoder, error) {
	if !validSourceAudioDecodeConfig(cfg, output) || clock == nil || !clock.adaptive {
		return nil, errors.New("lazy source audio config")
	}
	l := newSourceLazyState("audio/opus", clock, cfg.budget, cfg.authorized, cfg.revoked, output.Close)
	if !l.permitted() {
		return nil, errors.New("lazy source audio denied")
	}
	cfg.authorized = l.permitted
	l.prepare = func() (*sourcePendingDecoder, error) { return prepareSourceAudioDecoder(cfg, output) }
	go l.run()
	return l, nil
}

func newSourceLazyState(codec string, clock *sourceMediaClock, budget *sourceDecodeBudget, allowed func() bool, revoked <-chan struct{}, closeOutput func()) *sourceLazyDecoder {
	return &sourceLazyDecoder{sourceMediaClock: clock, codec: codec, revoked: revoked,
		allowed: func() bool { return budget.allowed() && allowed() }, outputClose: closeOutput,
		start: make(chan struct{}, 1), done: make(chan struct{}), finished: make(chan struct{})}
}

func (l *sourceLazyDecoder) permitted() bool {
	if l.closed.Load() {
		return false
	}
	select {
	case <-l.revoked:
		return false
	default:
		return l.allowed()
	}
}

func (l *sourceLazyDecoder) ready(ts uint32) bool {
	if l.codec == "audio/opus" {
		_, ok := l.AudioTiming(ts)
		return ok
	}
	_, ok := l.Map(ts)
	return ok
}

func (l *sourceLazyDecoder) BindSourceKeyframeRequester(request func() bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed.Load() || l.codec != "video/vp8" || request == nil || l.request != nil {
		return errors.New("lazy source feedback binding")
	}
	l.request = request
	return nil
}

func (l *sourceLazyDecoder) WriteEncoded(codec string, ts uint32, frame []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := false
	var err error
	if codec == "video/vp8" {
		_, _, key, err = sourceVP8Dimensions(frame)
	} else if codec == "audio/opus" {
		_, err = sourceOpusSamples(frame)
	}
	rate := uint32(48000)
	if l.codec == "video/vp8" {
		rate = 90000
	}
	if !l.permitted() || codec != l.codec || err != nil || l.observed && (ts == l.last || ts-l.last > rate*600) {
		l.closeLocked()
		return errors.New("lazy source input denied")
	}
	l.observed, l.last = true, ts
	if l.decoder.sink != nil {
		if l.needKey {
			if !key {
				l.requestLocked()
				return nil
			}
			l.needKey = false
		}
		if err = l.decoder.sink.WriteEncoded(codec, ts, frame); err != nil {
			l.closeLocked()
		}
		return err
	}
	if l.pending != nil {
		l.missing = true
		return nil
	}
	if !l.ready(ts) {
		return nil
	}
	if codec == "video/vp8" && !key {
		l.requestLocked()
		return nil
	}
	p, err := l.prepare()
	if err != nil {
		l.closeLocked()
		return err
	}
	l.pending = p
	// The pending decoder already charged its media profile. While this frame
	// exists there is no active decoder ingress; no uncharged second queue.
	l.frame = append([]byte(nil), frame...)
	l.timestamp = ts
	l.start <- struct{}{}
	return nil
}

func (l *sourceLazyDecoder) requestLocked() {
	if l.request != nil {
		l.request()
	}
}

func (l *sourceLazyDecoder) closeLocked() {
	if l.closed.Swap(true) {
		return
	}
	close(l.done)
	clear(l.frame)
	l.frame = nil
	l.pending.Close()
	if l.decoder.sink != nil {
		l.decoder.sink.Close()
	}
	l.outputClose()
	l.sourceMediaClock.Close()
	l.request = nil
}

func (l *sourceLazyDecoder) Close() { l.mu.Lock(); defer l.mu.Unlock(); l.closeLocked() }

func (l *sourceLazyDecoder) run() {
	type startResult struct {
		decoder sourceDecoderHandle
		err     error
	}
	results := make(chan startResult, 1)
	starting := false
	defer func() {
		l.Close()
		if starting {
			// A delayed syscall may finish after revoke. The supervisor already
			// erased warmup/output; the worker still owns admission until reaping.
			result := <-results
			if result.decoder.sink != nil {
				result.decoder.sink.Close()
				l.mu.Lock()
				l.decoder = result.decoder
				l.mu.Unlock()
			}
		}
		l.mu.Lock()
		d := l.decoder
		l.pending.Close()
		l.mu.Unlock()
		if d.finished != nil {
			<-d.finished
		}
		close(l.finished)
	}()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	startup := time.NewTimer(sourceClockTimeout)
	defer startup.Stop()
	var decodedDone <-chan struct{}
	for {
		select {
		case <-l.done:
			return
		case <-l.revoked:
			return
		case <-decodedDone:
			return
		case <-startup.C:
			if decodedDone == nil {
				return
			}
		case <-tick.C:
			if !l.permitted() || l.SourceClockTick() != nil {
				return
			}
			l.mu.Lock()
			if l.needKey {
				l.requestLocked()
			}
			l.mu.Unlock()
		case <-l.start:
			l.mu.Lock()
			p := l.pending
			l.mu.Unlock()
			starting = true
			go func() { d, err := p.Run(); results <- startResult{d, err} }()
		case result := <-results:
			starting = false
			d, err := result.decoder, result.err
			l.mu.Lock()
			if err != nil {
				l.closeLocked()
				l.mu.Unlock()
				return
			}
			l.decoder = d
			decodedDone = d.finished
			if !l.permitted() || !l.ready(l.timestamp) {
				d.sink.Close()
				l.closeLocked()
				l.mu.Unlock()
				return
			}
			if l.codec == "video/vp8" && l.missing {
				// Spawn-time loss must not feed delta frames referencing an omitted
				// frame. Ask for a new keyframe and let the decoder start there.
				l.needKey = true
				l.requestLocked()
			} else {
				err = d.sink.WriteEncoded(l.codec, l.timestamp, l.frame)
			}
			clear(l.frame)
			l.frame = nil
			l.pending.Close()
			l.pending = nil
			if err != nil {
				l.closeLocked()
			}
			l.mu.Unlock()
			if err != nil {
				return
			}
		}
	}
}
