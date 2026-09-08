package main

import (
	"errors"
	"sync"
)

// Explicitly shared by the native program owner, never inferred from a peer or
// created per input in production. Reservations limit concurrent codec processes
// and conservative owned-media capacity, not FFmpeg RSS or CPU consumption.
type sourceDecodeBudget struct {
	mu                      sync.Mutex
	maxProcesses, processes int
	maxBytes, bytes         int64
	closed                  bool
}

type sourceDecodeReservation struct {
	owner    *sourceDecodeBudget
	bytes    int64
	mu       sync.Mutex
	released bool
	charge   *sourceDecodeCharge
}

type sourceDecodeCharge struct {
	mu   sync.Mutex
	refs int
}

func newSourceDecodeBudget(processes int, bytes int64) (*sourceDecodeBudget, error) {
	if processes < 1 || processes > 80 || bytes < 1 || bytes > 2*1024*1024*1024 {
		return nil, errors.New("source decoder budget config")
	}
	return &sourceDecodeBudget{maxProcesses: processes, maxBytes: bytes}, nil
}

func (b *sourceDecodeBudget) reserve(bytes int64) (*sourceDecodeReservation, error) {
	if b == nil {
		return nil, errors.New("source decoder budget missing")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || bytes < 1 || bytes > b.maxBytes-b.bytes || b.processes >= b.maxProcesses {
		return nil, errors.New("source decoder budget exhausted")
	}
	b.processes++
	b.bytes += bytes
	return &sourceDecodeReservation{owner: b, bytes: bytes, charge: &sourceDecodeCharge{refs: 1}}, nil
}

func (b *sourceDecodeBudget) allowed() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return !b.closed
}

func (b *sourceDecodeBudget) Close() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	// Outstanding processes remain charged until their own reapers release them.
}

func (r *sourceDecodeReservation) release() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.released {
		return
	}
	r.released = true
	r.charge.mu.Lock()
	defer r.charge.mu.Unlock()
	r.charge.refs--
	if r.charge.refs == 0 {
		b := r.owner
		b.mu.Lock()
		defer b.mu.Unlock()
		b.processes--
		b.bytes -= r.bytes
	}
}

// Startup and its codec share one fixed charge until BOTH warmup erasure and
// process reaping. No second process or additional media quota is authorized.
func (r *sourceDecodeReservation) retain() *sourceDecodeReservation {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.released {
		return nil
	}
	r.charge.mu.Lock()
	defer r.charge.mu.Unlock()
	if r.charge.refs >= 2 {
		return nil
	}
	r.charge.refs++
	return &sourceDecodeReservation{owner: r.owner, bytes: r.bytes, charge: r.charge}
}

// Video: two queued and one writing encoded frame plus the borrowed RGBA
// output. Audio: nine encoded packets, PCM scratch and bounded Ogg framing fit
// in a rounded MiB. Neither includes kernel pipes, codec internals, transport
// assembly, mixer/compositor or resampler storage; those have separate owners.
func sourceVideoDecodeBytes(width, height int) int64 {
	return 3*sourceVideoFrameLimit + int64(width)*int64(height)*4
}

const sourceAudioDecodeBytes int64 = 1024 * 1024
