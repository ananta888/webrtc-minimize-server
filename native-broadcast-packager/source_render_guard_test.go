package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestSourceRenderGuardBoundedAndTerminal(t *testing.T) {
	var allowed atomic.Bool
	allowed.Store(true)
	f := &sourceRenderFence{allowed: allowed.Load}
	var g sourceRenderGuard
	for i := 0; i < 80; i++ {
		g.add(f)
	}
	if !g.Valid() {
		t.Fatal("valid bounded guard")
	}
	g.add(f)
	if g.Valid() {
		t.Fatal("oversize guard accepted")
	}
	g = sourceRenderGuard{}
	g.add(nil)
	if g.Valid() {
		t.Fatal("missing source fence")
	}
	g = sourceRenderGuard{}
	g.add(f)
	allowed.Store(false)
	if g.Valid() {
		t.Fatal("lease loss ignored")
	}
	allowed.Store(true)
	f.closed.Store(true)
	if g.Valid() {
		t.Fatal("closed generation revived")
	}
	f = &sourceRenderFence{}
	f.allowed = func() bool { f.closed.Store(true); return true }
	g = sourceRenderGuard{}
	g.add(f)
	if g.Valid() {
		t.Fatal("close during policy check ignored")
	}
}

func TestSourceRenderGuardsSurviveHandoffAndDetectSourceClose(t *testing.T) {
	a := audioMixFixture(t, 1920, 2)
	v := videoMixFixture(t, 2)
	x := audioMixInputFixture(t, a)
	y := videoMixInputFixture(t, v, "camera")
	if err := x.WritePCM(48000, 2, 0, audioMixPCM(960, 1000, 2000)); err != nil {
		t.Fatal(err)
	}
	if err := y.WriteRGBA(64, 36, 0, solidVideoMix(64, 36, 200, 0, 0)); err != nil {
		t.Fatal(err)
	}
	setVideoMixScene(t, v, "single", []*sourceVideoMixInput{y}, nil)
	var ag, vg sourceRenderGuard
	if err := a.RenderGuarded(func(_ int64, _ []byte, g sourceRenderGuard) error {
		ag = g
		if !g.Valid() {
			t.Error("audio guard unavailable under render lock")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := v.RenderGuarded(0, func(_ int64, _ uint64, _ []byte, g sourceRenderGuard) error {
		vg = g
		if !g.Valid() {
			t.Error("video guard unavailable under render lock")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if ag.count != 1 || vg.count != 1 || !ag.Valid() || !vg.Valid() {
		t.Fatal("handoff scope lost")
	}
	x.Close()
	if ag.Valid() || !vg.Valid() {
		t.Fatal("source-local invalidation failed")
	}
	y.Close()
	if vg.Valid() {
		t.Fatal("video guard survived source close")
	}
	x = audioMixInputFixture(t, a)
	if ag.Valid() {
		t.Fatal("new input revived previous guard")
	}
	x.Close()
}

func TestSourceRenderGuardConcurrentClose(t *testing.T) {
	f := &sourceRenderFence{allowed: func() bool { return true }}
	var g sourceRenderGuard
	g.add(f)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				g.Valid()
			}
		}()
	}
	f.closed.Store(true)
	wg.Wait()
	if g.Valid() {
		t.Fatal("terminal guard")
	}
}
