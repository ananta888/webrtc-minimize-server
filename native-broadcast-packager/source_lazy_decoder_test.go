package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type sourceLazyTestDecoder struct {
	mu          sync.Mutex
	frames      int
	firstKey    bool
	closed      bool
	finished    chan struct{}
	reservation *sourceDecodeReservation
}

func (d *sourceLazyTestDecoder) WriteEncoded(_ string, _ uint32, frame []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return errors.New("fixture decoder closed")
	}
	if d.frames == 0 {
		d.firstKey = frame[0]&1 == 0
	}
	d.frames++
	return nil
}
func (d *sourceLazyTestDecoder) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	d.closed = true
	d.reservation.release()
	close(d.finished)
}

func TestSourcePendingDecoderSingleOwnership(t *testing.T) {
	for _, mode := range []string{"abort", "revoke", "failure", "success", "early-reap"} {
		t.Run(mode, func(t *testing.T) {
			b := sourceDecodeTestBudget(t)
			var allowed atomic.Bool
			allowed.Store(true)
			var calls atomic.Int32
			p, err := newSourcePendingDecoder(b, 1024, allowed.Load, func(r *sourceDecodeReservation) (sourceDecoderHandle, error) {
				calls.Add(1)
				if mode == "failure" {
					return sourceDecoderHandle{}, errors.New("fixture start failure")
				}
				d := &sourceLazyTestDecoder{reservation: r, finished: make(chan struct{})}
				return sourceDecoderHandle{sink: d, finished: d.finished}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "abort" {
				p.Close()
				p.Close()
			}
			if mode == "revoke" {
				allowed.Store(false)
			}
			d, err := p.Run()
			if mode == "early-reap" {
				if err != nil {
					t.Fatal(err)
				}
				d.sink.Close()
				if b.processes != 1 {
					t.Fatal("early reaping erased warmup reservation")
				}
			} else if mode == "success" {
				if err != nil {
					t.Fatal(err)
				}
				p.Close()
				if b.processes != 1 {
					t.Fatal("start owner reclaimed running codec")
				}
				if _, err = p.Run(); err == nil || b.processes != 1 {
					t.Fatal("duplicate start altered live reservation")
				}
				d.sink.Close()
			} else if err == nil {
				t.Fatal("denied start succeeded")
			}
			if mode == "failure" || mode == "revoke" {
				if b.processes != 1 {
					t.Fatal("failure released warmup budget before owner cleanup")
				}
			}
			p.Close()
			if b.processes != 0 || b.bytes != 0 {
				t.Fatal("startup reservation leak")
			}
			if calls.Load() > 1 || (mode == "abort" || mode == "revoke") && calls.Load() != 0 {
				t.Fatal("unauthorized startup")
			}
		})
	}
}

type sourceLazyTestState struct {
	l        *sourceLazyDecoder
	b        *sourceDecodeBudget
	d        *sourceLazyTestDecoder
	entered  chan struct{}
	unblock  func()
	revoke   func()
	requests atomic.Int32
}

func lazyVideoFixture(t *testing.T, ready bool) *sourceLazyTestState {
	return lazyVideoFixtureClock(t, ready, time.Now)
}

func lazyVideoFixtureClock(t *testing.T, ready bool, clock func() time.Time) *sourceLazyTestState {
	t.Helper()
	b := sourceDecodeTestBudget(t)
	now := clock()
	g, err := newSourcePublisherClock(now, clock, 14400)
	if err != nil {
		t.Fatal(err)
	}
	c, err := g.NewSource()
	if err != nil {
		t.Fatal(err)
	}
	if err = c.BindSourceClock(1, 90000); err != nil {
		t.Fatal(err)
	}
	if ready {
		readyLazyClock(t, c)
	}
	d := &sourceLazyTestDecoder{finished: make(chan struct{})}
	state := &sourceLazyTestState{b: b, d: d, entered: make(chan struct{}, 1)}
	gate := make(chan struct{})
	var once sync.Once
	state.unblock = func() { once.Do(func() { close(gate) }) }
	revoked := make(chan struct{})
	state.revoke = func() { close(revoked) }
	l := newSourceLazyState("video/vp8", c, b, func() bool { return true }, revoked, func() {})
	state.l = l
	l.prepare = func() (*sourcePendingDecoder, error) {
		return newSourcePendingDecoder(b, sourceVideoDecodeBytes(64, 32), l.permitted,
			func(r *sourceDecodeReservation) (sourceDecoderHandle, error) {
				state.entered <- struct{}{}
				<-gate
				d.reservation = r
				return sourceDecoderHandle{sink: d, finished: d.finished}, nil
			})
	}
	if err = l.BindSourceKeyframeRequester(func() bool { state.requests.Add(1); return true }); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { state.unblock(); l.Close(); awaitSource(t, l.finished); g.Close() })
	go l.run()
	return state
}

func readyLazyClock(t *testing.T, c *sourceMediaClock) {
	t.Helper()
	if err := c.SourceSenderReport(sourceSenderReport{ssrc: 1, ntp: 1 << 32, rtp: 1000}); err != nil {
		t.Fatal(err)
	}
	if err := c.SourceSenderReport(sourceSenderReport{ssrc: 1, ntp: 2 << 32, rtp: 91000}); err != nil {
		t.Fatal(err)
	}
}

func awaitLazyActive(t *testing.T, l *sourceLazyDecoder) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		l.mu.Lock()
		active := l.decoder.sink != nil
		l.mu.Unlock()
		if active {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("lazy activation deadline")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSourceLazyClockAndKeyframeBeforeReservation(t *testing.T) {
	f := lazyVideoFixture(t, false)
	if err := f.l.WriteEncoded("video/vp8", 2000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	f.b.mu.Lock()
	charged := f.b.processes
	f.b.mu.Unlock()
	if charged != 0 || len(f.l.frame) != 0 {
		t.Fatal("unknown clock retained media or decoder")
	}
	readyLazyClock(t, f.l.sourceMediaClock)
	if err := f.l.WriteEncoded("video/vp8", 92000, []byte{0x11, 0, 0}); err != nil {
		t.Fatal(err)
	}
	if f.requests.Load() != 1 || f.l.pending != nil {
		t.Fatal("delta allocated decoder instead of requesting keyframe")
	}
	if err := f.l.WriteEncoded("video/vp8", 95000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	awaitSource(t, f.entered)
	f.b.mu.Lock()
	charged = f.b.processes
	f.b.mu.Unlock()
	if charged != 1 {
		t.Fatal("startup frame not reserved")
	}
	f.unblock()
	awaitLazyActive(t, f.l)
	f.d.mu.Lock()
	defer f.d.mu.Unlock()
	if f.d.frames != 1 || !f.d.firstKey {
		t.Fatal("initial frame not transferred")
	}
}

func TestSourceLazySpawnLossRequiresFreshKeyframe(t *testing.T) {
	f := lazyVideoFixture(t, true)
	if err := f.l.WriteEncoded("video/vp8", 92000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	awaitSource(t, f.entered)
	if err := f.l.WriteEncoded("video/vp8", 95000, []byte{0x11, 0, 0}); err != nil {
		t.Fatal(err)
	}
	f.unblock()
	awaitLazyActive(t, f.l)
	if err := f.l.WriteEncoded("video/vp8", 98000, []byte{0x11, 0, 0}); err != nil {
		t.Fatal(err)
	}
	f.d.mu.Lock()
	count := f.d.frames
	f.d.mu.Unlock()
	if count != 0 || f.requests.Load() == 0 {
		t.Fatal("broken VP8 chain forwarded")
	}
	if err := f.l.WriteEncoded("video/vp8", 101000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	f.d.mu.Lock()
	defer f.d.mu.Unlock()
	if f.d.frames != 1 || !f.d.firstKey {
		t.Fatal("fresh keyframe not used")
	}
}

func lazySpawnQuarantineFixture(t *testing.T) (*sourceLazyTestState, func(int)) {
	t.Helper()
	var epoch atomic.Int64
	start := time.Now()
	epoch.Store(start.UnixNano())
	setNow := func(second int) { epoch.Store(start.Add(time.Duration(second) * time.Second).UnixNano()) }
	f := lazyVideoFixtureClock(t, true, func() time.Time { return time.Unix(0, epoch.Load()) })
	if err := f.l.WriteEncoded("video/vp8", 92000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	awaitSource(t, f.entered)
	f.l.mu.Lock()
	warmup := f.l.frame
	f.l.mu.Unlock()
	setNow(2)
	if err := f.l.SourceSenderReport(sourceSenderReport{1, 3 << 32, 183000}); err != nil {
		t.Fatal(err)
	}
	if f.l.VideoTime().state != sourceVideoTimeSuspended {
		t.Fatal("fixture did not enter recoverable quarantine")
	}
	f.unblock()
	awaitLazyActive(t, f.l)
	if f.l.closed.Load() {
		t.Fatal("temporary clock quarantine during spawn permanently closed the source")
	}
	for _, b := range warmup {
		if b != 0 {
			t.Fatal("quarantine retained startup plaintext")
		}
	}
	return f, setNow
}

func TestSourceLazySpawnQuarantineRecoversOnlyWithFreshClockAndKeyframe(t *testing.T) {
	f, setNow := lazySpawnQuarantineFixture(t)
	assertFrames := func(want int) {
		t.Helper()
		f.d.mu.Lock()
		defer f.d.mu.Unlock()
		if f.d.frames != want || (want > 0 && !f.d.firstKey) {
			t.Fatal("unexpected decoder output or missing fresh keyframe", f.d.frames)
		}
	}
	assertFrames(0)
	if err := f.l.WriteEncoded("video/vp8", 185000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	assertFrames(0)
	setNow(3)
	if err := f.l.SourceSenderReport(sourceSenderReport{1, 4 << 32, 271000}); err != nil {
		t.Fatal(err)
	}
	if err := f.l.WriteEncoded("video/vp8", 275000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	assertFrames(0)
	if f.requests.Load() != 0 {
		t.Fatal("unready clock requested unnecessary keyframes")
	}
	setNow(4)
	if err := f.l.SourceSenderReport(sourceSenderReport{1, 5 << 32, 361000}); err != nil {
		t.Fatal(err)
	}
	if f.l.VideoTime().state != sourceVideoTimeReady {
		t.Fatal("two valid reports failed to restore clock")
	}
	if err := f.l.WriteEncoded("video/vp8", 365000, []byte{0x11, 0, 0}); err != nil {
		t.Fatal(err)
	}
	assertFrames(0)
	if f.requests.Load() == 0 {
		t.Fatal("recovery did not request a fresh keyframe")
	}
	if err := f.l.WriteEncoded("video/vp8", 368000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	assertFrames(1)
	f.b.mu.Lock()
	defer f.b.mu.Unlock()
	if f.b.processes != 1 {
		t.Fatal("quarantine recovery changed decoder budget")
	}
}

func TestSourceLazySpawnQuarantineKeepsTerminalBoundaries(t *testing.T) {
	for _, mode := range []string{"revoke", "budget", "clock-closed", "expired", "invalid-timestamp", "replay"} {
		t.Run(mode, func(t *testing.T) {
			f, setNow := lazySpawnQuarantineFixture(t)
			switch mode {
			case "revoke":
				f.revoke()
			case "budget":
				f.b.Close()
			case "clock-closed":
				f.l.sourceMediaClock.Close()
			case "replay":
				if err := f.l.WriteEncoded("video/vp8", 92000, syntheticVP8Key()); err == nil {
					t.Fatal("quarantine erased the timestamp replay fence")
				}
			case "expired":
				setNow(14)
				if f.l.SourceClockTick() == nil {
					t.Fatal("quarantine extended the clock deadline")
				}
			case "invalid-timestamp":
				for second := 3; second <= 4; second++ {
					setNow(second)
					if err := f.l.SourceSenderReport(sourceSenderReport{1, uint64(second+1) << 32, 1000 + uint32(second)*90000}); err != nil {
						t.Fatal(err)
					}
				}
				if err := f.l.WriteEncoded("video/vp8", 361000+13*90000, syntheticVP8Key()); err == nil {
					t.Fatal("invalid media timestamp revived waiting decoder")
				}
			}
			awaitSource(t, f.l.finished)
			if !f.l.closed.Load() || !f.d.closed || f.d.frames != 0 {
				t.Fatal("terminal quarantine source remained usable")
			}
			f.b.mu.Lock()
			defer f.b.mu.Unlock()
			if f.b.processes != 0 || f.b.bytes != 0 {
				t.Fatal("terminal quarantine retained decoder admission")
			}
		})
	}
}

func TestSourceLazyCloseDuringSpawnWipesWarmup(t *testing.T) {
	f := lazyVideoFixture(t, true)
	if err := f.l.WriteEncoded("video/vp8", 92000, syntheticVP8Key()); err != nil {
		t.Fatal(err)
	}
	awaitSource(t, f.entered)
	f.l.mu.Lock()
	held := f.l.frame
	f.l.mu.Unlock()
	f.l.Close()
	f.l.Close()
	for _, value := range held {
		if value != 0 {
			t.Fatal("warmup plaintext survived revoke")
		}
	}
	f.b.mu.Lock()
	charged := f.b.processes
	f.b.mu.Unlock()
	if charged != 1 {
		t.Fatal("inflight startup released prematurely")
	}
	f.unblock()
	awaitSource(t, f.l.finished)
	if f.d.frames != 0 || !f.d.closed {
		t.Fatal("late startup escaped revocation")
	}
	if err := f.l.WriteEncoded("video/vp8", 95000, syntheticVP8Key()); err == nil {
		t.Fatal("terminal source revived")
	}
}

func TestSourceLazySupervisorRevokesBlockedStart(t *testing.T) {
	for _, mode := range []string{"budget", "clock"} {
		t.Run(mode, func(t *testing.T) {
			f := lazyVideoFixture(t, true)
			if err := f.l.WriteEncoded("video/vp8", 92000, syntheticVP8Key()); err != nil {
				t.Fatal(err)
			}
			awaitSource(t, f.entered)
			f.l.mu.Lock()
			held := f.l.frame
			f.l.mu.Unlock()
			if mode == "budget" {
				f.b.Close()
			} else {
				f.l.sourceMediaClock.Close()
			}
			awaitSource(t, f.l.done)
			f.l.mu.Lock()
			for _, v := range held {
				if v != 0 {
					t.Error("blocked start retained revoked media")
				}
			}
			f.l.mu.Unlock()
			select {
			case <-f.l.finished:
				t.Fatal("inflight start falsely reported reaped")
			default:
			}
			f.unblock()
			awaitSource(t, f.l.finished)
			if !f.d.closed || f.d.frames != 0 {
				t.Fatal("late decoder escaped supervisor")
			}
		})
	}
}

func TestSourceLazyDeniedInputsAndIdleClockClose(t *testing.T) {
	for _, mode := range []string{"codec", "frame", "budget", "clock"} {
		t.Run(mode, func(t *testing.T) {
			f := lazyVideoFixture(t, true)
			codec, frame := "video/vp8", syntheticVP8Key()
			switch mode {
			case "codec":
				codec = "audio/opus"
			case "frame":
				frame = frame[:2]
			case "budget":
				f.b.Close()
			case "clock":
				f.l.sourceMediaClock.Close()
			}
			if mode != "clock" {
				if err := f.l.WriteEncoded(codec, 92000, frame); err == nil {
					t.Fatal("invalid source accepted")
				}
			}
			awaitSource(t, f.l.finished)
			if f.l.pending != nil || len(f.l.frame) != 0 {
				t.Fatal("denied input retained")
			}
		})
	}
}
