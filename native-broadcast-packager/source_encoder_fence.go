package main

import (
	"sync"
	"sync/atomic"
)

// One encoder generation remembers every contributing source, including
// frames no longer in the raw pipe queues. Removal requires a new generation;
// no key, peer identity or policy authority is created here.
type sourceEncoderFence struct {
	mu      sync.Mutex
	closed  atomic.Bool
	writer  func() bool // bounded/thread-safe, no reentry
	sources sourceRenderGuard
}

func (f *sourceEncoderFence) validLocked() bool {
	if f.closed.Load() || f.writer == nil || !f.writer() || !f.sources.Valid() {
		f.closed.Store(true)
		return false
	}
	return !f.closed.Load()
}

func (f *sourceEncoderFence) Valid() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.validLocked()
}

// Called before media is given to a raw writer, without filesystem/process
// I/O. Slots are fixed; a full generation must stop, never forget old guards.
func (f *sourceEncoderFence) Admit(g sourceRenderGuard) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.validLocked() || !g.Valid() {
		f.closed.Store(true)
		return false
	}
	for i := 0; i < g.count; i++ {
		found := false
		for j := 0; j < f.sources.count; j++ {
			found = found || f.sources.fences[j] == g.fences[i]
		}
		if !found {
			if f.sources.count == len(f.sources.fences) {
				f.closed.Store(true)
				return false
			}
			f.sources.add(g.fences[i])
		}
	}
	return f.validLocked()
}

func (f *sourceEncoderFence) Revoke() { f.closed.Store(true) }

// Only after all output/process workers have exited.
func (f *sourceEncoderFence) Clear() {
	f.closed.Store(true)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sources = sourceRenderGuard{}
	f.writer = nil
}
