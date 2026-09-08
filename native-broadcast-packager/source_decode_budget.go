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
	owner *sourceDecodeBudget
	bytes int64
	once  sync.Once
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
	return &sourceDecodeReservation{owner: b, bytes: bytes}, nil
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
	r.once.Do(func() {
		b := r.owner
		b.mu.Lock()
		defer b.mu.Unlock()
		b.processes--
		b.bytes -= r.bytes
	})
}

// Video: two queued and one writing encoded frame plus the borrowed RGBA
// output. Audio: nine encoded packets, PCM scratch and bounded Ogg framing fit
// in a rounded MiB. Neither includes kernel pipes, codec internals, transport
// assembly, mixer/compositor or resampler storage; those have separate owners.
func sourceVideoDecodeBytes(width, height int) int64 {
	return 3*sourceVideoFrameLimit + int64(width)*int64(height)*4
}

const sourceAudioDecodeBytes int64 = 1024 * 1024
