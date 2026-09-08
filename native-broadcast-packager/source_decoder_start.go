package main

import (
	"errors"
	"sync"
)

type sourceDecoderHandle struct {
	sink     trustedSourceSink
	finished <-chan struct{}
}

// One reserved startup, not a general factory or transferable permission.
// Close aborts before Run and drops the owner's warmup hold thereafter. Once
// running, the codec has a separate hold on the SAME charge through reaping.
type sourcePendingDecoder struct {
	mu          sync.Mutex
	claimed     bool
	reservation *sourceDecodeReservation
	held        *sourceDecodeReservation
	allowed     func() bool
	start       func(*sourceDecodeReservation) (sourceDecoderHandle, error)
}

func newSourcePendingDecoder(b *sourceDecodeBudget, bytes int64, allowed func() bool,
	start func(*sourceDecodeReservation) (sourceDecoderHandle, error)) (*sourcePendingDecoder, error) {
	if allowed == nil || start == nil || !allowed() {
		return nil, errors.New("source decoder start denied")
	}
	r, err := b.reserve(bytes)
	if err != nil {
		return nil, err
	}
	return &sourcePendingDecoder{reservation: r, allowed: allowed, start: start}, nil
}

func (p *sourcePendingDecoder) Run() (sourceDecoderHandle, error) {
	p.mu.Lock()
	if p.claimed {
		p.mu.Unlock()
		return sourceDecoderHandle{}, errors.New("source decoder start consumed")
	}
	p.claimed = true
	r, allowed, start := p.reservation, p.allowed, p.start
	child := r.retain()
	p.held = r
	p.reservation, p.allowed, p.start = nil, nil, nil
	p.mu.Unlock()
	if child == nil || !r.owner.allowed() || !allowed() {
		child.release()
		return sourceDecoderHandle{}, errors.New("source decoder start revoked")
	}
	d, err := start(child)
	if err != nil {
		// The owner may still hold a warmup frame. Keep its charge until that
		// frame is erased and the owner calls Close, including failed starts.
		child.release()
	}
	return d, err
}

func (p *sourcePendingDecoder) Close() {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.claimed {
		p.held.release()
		p.held = nil
		return
	}
	p.claimed = true
	p.reservation.release()
	p.reservation, p.allowed, p.start = nil, nil, nil
}
