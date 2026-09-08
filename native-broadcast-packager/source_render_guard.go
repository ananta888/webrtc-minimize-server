package main

import "sync/atomic"

// Local generation capability only, never a wire identity. The callback is
// immutable, bounded/thread-safe and must not reenter the originating mixer.
type sourceRenderFence struct {
	closed  atomic.Bool
	allowed func() bool
}

func (f *sourceRenderFence) valid() bool {
	return f != nil && !f.closed.Load() && f.allowed != nil && f.allowed() && !f.closed.Load()
}

// Fixed-size snapshot of potentially contributing sources, no growable list
// and no mixer locks. Downstream queues must retain it and check immediately
// before handoff, or replace invalid content with silence/slate. Empty means
// no source contribution, NOT writer authorization; that is checked separately.
type sourceRenderGuard struct {
	count  int
	fences [80]*sourceRenderFence
}

func (g sourceRenderGuard) Valid() bool {
	if g.count < 0 || g.count > len(g.fences) {
		return false
	}
	for i := 0; i < g.count; i++ {
		if !g.fences[i].valid() {
			return false
		}
	}
	return true
}

func (g *sourceRenderGuard) add(f *sourceRenderFence) {
	if g.count >= len(g.fences) {
		g.count = len(g.fences) + 1
		return
	}
	g.fences[g.count] = f
	g.count++
}
