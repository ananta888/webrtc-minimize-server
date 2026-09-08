package main

import (
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
)

func sourceDecodeTestBudget(t *testing.T) *sourceDecodeBudget {
	t.Helper()
	b, err := newSourceDecodeBudget(2, 64*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		b.Close()
		deadline := time.Now().Add(time.Second)
		for {
			b.mu.Lock()
			processes, bytes := b.processes, b.bytes
			b.mu.Unlock()
			if processes == 0 && bytes == 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Error("source decoder reservation survived fixture cleanup")
				return
			}
			time.Sleep(time.Millisecond)
		}
	})
	return b
}

func TestSourceDecodeBudgetBoundsAndOwnership(t *testing.T) {
	for _, cfg := range []struct {
		processes int
		bytes     int64
	}{{0, 1}, {81, 1}, {1, 0}, {1, -1}, {1, 2*1024*1024*1024 + 1}} {
		if b, err := newSourceDecodeBudget(cfg.processes, cfg.bytes); err == nil || b != nil {
			t.Fatal("invalid budget accepted")
		}
	}
	var absent *sourceDecodeBudget
	if _, err := absent.reserve(1); err == nil || absent.allowed() {
		t.Fatal("implicit budget")
	}
	b, _ := newSourceDecodeBudget(2, 100)
	for _, cost := range []int64{0, -1, 101, 1 << 62} {
		if _, err := b.reserve(cost); err == nil {
			t.Fatal("invalid reservation")
		}
	}
	a, err := b.reserve(60)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.reserve(41); err == nil {
		t.Fatal("byte quota bypass")
	}
	c, err := b.reserve(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.reserve(1); err == nil {
		t.Fatal("process quota bypass")
	}
	a.release()
	a.release()
	d, err := b.reserve(99)
	if err != nil {
		t.Fatal("released capacity unavailable")
	}
	b.Close()
	b.Close()
	if b.allowed() || b.processes != 2 || b.bytes != 100 {
		t.Fatal("close dropped live accounting")
	}
	if _, err := b.reserve(1); err == nil {
		t.Fatal("terminal budget revived")
	}
	c.release()
	d.release()
	if b.processes != 0 || b.bytes != 0 {
		t.Fatal("reservation leak")
	}
}

func TestSourceDecodeBudgetConcurrentReservations(t *testing.T) {
	b, _ := newSourceDecodeBudget(4, 100)
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 100; j++ {
				r, err := b.reserve(25)
				if err != nil {
					continue
				}
				b.mu.Lock()
				if b.processes > 4 || b.bytes > 100 {
					t.Error("concurrent quota bypass")
				}
				b.mu.Unlock()
				r.release()
				r.release()
			}
		}()
	}
	workers.Wait()
	r, err := b.reserve(25)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); r.release() }()
	}
	workers.Wait()
	if b.processes != 0 || b.bytes != 0 {
		t.Fatal("parallel release leak")
	}
}

func TestSourceDecodeBudgetConstructorFailuresRelease(t *testing.T) {
	b := sourceDecodeTestBudget(t)
	for i := 0; i < 5; i++ {
		if _, err := newSourceAudioDecoder(sourceAudioDecodeConfig{budget: b, ffmpegPath: "/missing-source-decoder/ffmpeg",
			authorized: func() bool { return true }, revoked: make(chan struct{})}, &decodedAudioFixture{}); err == nil {
			t.Fatal("missing executable accepted")
		}
		if _, err := newSourceVideoDecoder(sourceVideoDecodeConfig{budget: b, ffmpegPath: "/missing-source-decoder/ffmpeg", width: 64, height: 32,
			authorized: func() bool { return true }, revoked: make(chan struct{})}, &decodedVideoFixture{}); err == nil {
			t.Fatal("missing executable accepted")
		}
		if b.processes != 0 || b.bytes != 0 {
			t.Fatal("failed start retained admission")
		}
	}
	b.Close()
	if _, err := b.reserve(1); err == nil {
		t.Fatal("closed budget admission")
	}
}

// The worker barrier deliberately delays reaping after Close has signaled and
// killed the real FFmpeg child. A stop request must never free its reservation.
func TestLiveTrustedSourceDecoderAdmission(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit admission gate requires FFmpeg")
	}
	b, _ := newSourceDecodeBudget(1, 32*1024*1024)
	t.Cleanup(b.Close)
	tiny, _ := newSourceDecodeBudget(1, 1)
	closed, _ := newSourceDecodeBudget(1, 32*1024*1024)
	closed.Close()
	for _, denied := range []*sourceDecodeBudget{nil, tiny, closed} {
		if d, err := newSourceAudioDecoder(sourceAudioDecodeConfig{budget: denied, ffmpegPath: ffmpeg,
			authorized: func() bool { return true }, revoked: make(chan struct{})}, &decodedAudioFixture{}); err == nil || d != nil {
			if d != nil {
				d.Close()
			}
			t.Fatal("audio started without usable admission")
		}
		if d, err := newSourceVideoDecoder(sourceVideoDecodeConfig{budget: denied, ffmpegPath: ffmpeg, width: 64, height: 32,
			authorized: func() bool { return true }, revoked: make(chan struct{})}, &decodedVideoFixture{}); err == nil || d != nil {
			if d != nil {
				d.Close()
			}
			t.Fatal("video started without usable admission")
		}
	}
	a, err := newSourceAudioDecoder(sourceAudioDecodeConfig{budget: b, ffmpegPath: ffmpeg,
		authorized: func() bool { return true }, revoked: make(chan struct{})}, &decodedAudioFixture{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	a.workers.Add(1)
	var barrier sync.Once
	releaseBarrier := func() { barrier.Do(a.workers.Done) }
	t.Cleanup(releaseBarrier)
	a.Close()
	if _, err := b.reserve(1); err == nil {
		t.Fatal("Close released before worker/reaping barrier")
	}
	select {
	case <-a.finished:
		t.Fatal("reaper skipped live worker")
	default:
	}
	releaseBarrier()
	select {
	case <-a.finished:
	case <-time.After(time.Second):
		t.Fatal("audio process not reaped")
	}
	if a.cmd.ProcessState == nil {
		t.Fatal("missing process wait")
	}
	v, err := newSourceVideoDecoder(sourceVideoDecodeConfig{budget: b, ffmpegPath: ffmpeg, width: 64, height: 32,
		authorized: func() bool { return true }, revoked: make(chan struct{})}, &decodedVideoFixture{})
	if err != nil {
		t.Fatal("reaped process capacity not reusable")
	}
	t.Cleanup(v.Close)
	if _, err := newSourceAudioDecoder(sourceAudioDecodeConfig{budget: b, ffmpegPath: ffmpeg,
		authorized: func() bool { return true }, revoked: make(chan struct{})}, &decodedAudioFixture{}); err == nil {
		t.Fatal("mixed codec process quota bypass")
	}
	b.Close()
	select {
	case <-v.finished:
	case <-time.After(time.Second):
		t.Fatal("owner close did not terminate idle decoder")
	}
	if v.cmd.ProcessState == nil || b.bytes != 0 || b.processes != 0 {
		t.Fatal("closed budget reaping leak")
	}
	if _, err := b.reserve(1); err == nil {
		t.Fatal("owner generation revived")
	}
}
