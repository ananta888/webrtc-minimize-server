package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestSourceEncoderFenceRetainsAllContributorsUntilTerminal(t *testing.T) {
	var writer atomic.Bool
	writer.Store(true)
	f := &sourceEncoderFence{writer: writer.Load}
	sources := make([]*sourceRenderFence, 80)
	for i := range sources {
		sources[i] = &sourceRenderFence{allowed: func() bool { return true }}
		var g sourceRenderGuard
		g.add(sources[i])
		if !f.Admit(g) || !f.Admit(g) {
			t.Fatal("source or duplicate admission failed")
		}
	}
	if f.sources.count != 80 {
		t.Fatal("generation forgot or duplicated source")
	}
	if !f.Admit(sourceRenderGuard{}) {
		t.Fatal("silence requires no source slot")
	}
	sources[0].closed.Store(true)
	if f.Valid() {
		t.Fatal("old contributor lost after pipe handoff")
	}
	if f.Admit(sourceRenderGuard{}) {
		t.Fatal("empty future frame revived generation")
	}
	f.Clear()
	if f.sources.count != 0 || f.writer != nil || f.Valid() {
		t.Fatal("terminal clear")
	}
}

func TestSourceEncoderFenceInvalidAndOversizeStayClosed(t *testing.T) {
	for _, mode := range []string{"writer", "nil-writer", "invalid", "quota", "revoke"} {
		t.Run(mode, func(t *testing.T) {
			f := &sourceEncoderFence{writer: func() bool { return true }}
			g := sourceRenderGuard{}
			switch mode {
			case "writer":
				f.writer = func() bool { return false }
			case "nil-writer":
				f.writer = nil
			case "invalid":
				g.add(nil)
			case "quota":
				for i := 0; i < 80; i++ {
					var one sourceRenderGuard
					one.add(&sourceRenderFence{allowed: func() bool { return true }})
					if !f.Admit(one) {
						t.Fatal("quota setup")
					}
				}
				g.add(&sourceRenderFence{allowed: func() bool { return true }})
			case "revoke":
				f.Revoke()
			}
			if f.Admit(g) || f.Valid() || f.Admit(sourceRenderGuard{}) {
				t.Fatal("invalid generation accepted/revived")
			}
		})
	}
}

func TestSourceEncoderFenceConcurrentUseAndClose(t *testing.T) {
	f := &sourceEncoderFence{writer: func() bool { return true }}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var g sourceRenderGuard
			g.add(&sourceRenderFence{allowed: func() bool { return true }})
			for j := 0; j < 100; j++ {
				f.Admit(g)
				f.Valid()
			}
		}()
	}
	f.Revoke()
	wg.Wait()
	f.Clear()
	if f.Valid() {
		t.Fatal("concurrent revive")
	}
}
