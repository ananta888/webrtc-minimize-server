package main

import (
	"sync"
	"sync/atomic"
)

const (
	sourceEncoderFailureNone uint32 = iota
	sourceEncoderFailureSource
	sourceEncoderFailureWriter
	sourceEncoderFailureStopped
	sourceEncoderFailureGuard
	sourceEncoderFailureQuota
)

// One encoder generation remembers every contributing source, including
// frames no longer in the raw pipe queues. Removal requires a new generation;
// no key, peer identity or policy authority is created here.
type sourceEncoderFence struct {
	mu      sync.Mutex
	closed  atomic.Bool
	failure atomic.Uint32 // First cause is irreversible, including across Clear.
	writer  func() bool   // bounded/thread-safe, no reentry
	sources sourceRenderGuard
}

func (f *sourceEncoderFence) validLocked() bool {
	if f.closed.Load() {
		return false
	}
	if f.writer == nil || !f.writer() {
		return f.fail(sourceEncoderFailureWriter)
	}
	if !f.sources.Valid() {
		return f.fail(sourceEncoderFailureSource)
	}
	return !f.closed.Load()
}

func (f *sourceEncoderFence) fail(reason uint32) bool {
	f.failure.CompareAndSwap(sourceEncoderFailureNone, reason)
	f.closed.Store(true)
	return false
}

// Invalid wire/internal shapes are not a publisher revocation. No retry may
// turn corruption, exhausted capacity or a deliberate owner stop into recovery.
func sourceEncoderGuardShape(g sourceRenderGuard) bool {
	if g.count < 0 || g.count > len(g.fences) {
		return false
	}
	for i := 0; i < g.count; i++ {
		if g.fences[i] == nil || g.fences[i].allowed == nil {
			return false
		}
	}
	return true
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
	if !f.validLocked() {
		return false
	}
	if !sourceEncoderGuardShape(g) {
		return f.fail(sourceEncoderFailureGuard)
	}
	if !g.Valid() {
		return f.fail(sourceEncoderFailureSource)
	}
	for i := 0; i < g.count; i++ {
		found := false
		for j := 0; j < f.sources.count; j++ {
			found = found || f.sources.fences[j] == g.fences[i]
		}
		if !found {
			if f.sources.count == len(f.sources.fences) {
				return f.fail(sourceEncoderFailureQuota)
			}
			f.sources.add(g.fences[i])
		}
	}
	return f.validLocked()
}

func (f *sourceEncoderFence) Revoke() { f.fail(sourceEncoderFailureStopped) }

// Only after all output/process workers have exited.
func (f *sourceEncoderFence) Clear() {
	f.Revoke()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sources = sourceRenderGuard{}
	f.writer = nil
}
