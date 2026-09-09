package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type rolloverTestFrame struct {
	video bool
	at    int64
	first byte
}
type rolloverTestEncoder struct {
	mu                    sync.Mutex
	cfg                   sourceProgramEncoderConfig
	ready, stop, finished chan struct{}
	stopOnce, finishOnce  sync.Once
	retry                 atomic.Bool
	hold                  bool
	frames                []rolloverTestFrame
}

func rolloverEncoder(c sourceProgramEncoderConfig) *rolloverTestEncoder {
	return &rolloverTestEncoder{cfg: c, ready: make(chan struct{}), stop: make(chan struct{}), finished: make(chan struct{})}
}
func (f *rolloverTestEncoder) ReadySignal() <-chan struct{} { return f.ready }
func (f *rolloverTestEncoder) StopSignal() <-chan struct{}  { return f.stop }
func (f *rolloverTestEncoder) Finished() <-chan struct{}    { return f.finished }
func (f *rolloverTestEncoder) CanRollover() bool            { return f.retry.Load() }
func (f *rolloverTestEncoder) CurrentReady() bool {
	select {
	case <-f.stop:
		return false
	default:
	}
	select {
	case <-f.ready:
		return true
	default:
		return false
	}
}
func (f *rolloverTestEncoder) Close() {
	f.stopOnce.Do(func() { close(f.stop) })
	if !f.hold {
		f.finish()
	}
}
func (f *rolloverTestEncoder) finish() { f.finishOnce.Do(func() { close(f.finished) }) }
func (f *rolloverTestEncoder) WriteProgramAudio(at int64, b []byte, _ sourceRenderGuard) error {
	return f.write(at, b, false)
}
func (f *rolloverTestEncoder) WriteProgramVideo(at int64, _ uint64, b []byte, _ sourceRenderGuard) error {
	return f.write(at, b, true)
}
func (f *rolloverTestEncoder) write(at int64, b []byte, video bool) error {
	select {
	case <-f.stop:
		return errors.New("stopped fixture")
	default:
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.frames = append(f.frames, rolloverTestFrame{video, at, b[0]})
	return nil
}

func rolloverWait(t *testing.T, predicate func() bool) {
	t.Helper()
	end := time.Now().Add(2 * time.Second)
	for !predicate() {
		if time.Now().After(end) {
			t.Fatal("rollover fixture deadline")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func rolloverWriteSteps(t *testing.T, p *sourceProgramRollover, first, last int) {
	t.Helper()
	for step := first; step <= last; step++ {
		if err := p.WriteProgramAudio(int64(step*960), make([]byte, 3840), sourceRenderGuard{}); err != nil {
			t.Fatal(err)
		}
		if step%5 == 0 {
			if err := p.WriteProgramVideo(int64(step*960), 1, make([]byte, 64*36*4), sourceRenderGuard{}); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestSourceRolloverDrainsBeforeConstructingAndAlignsBothLanes(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	var first, second *rolloverTestEncoder
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	create := func(cfg sourceProgramEncoderConfig) (sourceRolloverEncoder, error) {
		if cfg.hlsEpoch == 0 {
			first = rolloverEncoder(cfg)
			first.hold = true
			return first, nil
		}
		second = rolloverEncoder(cfg)
		close(entered)
		<-release
		return second, nil
	}
	p, err := newSourceProgramRolloverWithFactory(c, create)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { once.Do(func() { close(release) }); first.finish(); p.Close(); awaitSource(t, p.finished) })
	rolloverWriteSteps(t, p, 0, 0)
	close(first.ready)
	awaitSource(t, p.ready)
	if !p.CurrentReady() {
		t.Fatal("initial output not ready")
	}
	first.retry.Store(true)
	first.Close()
	rolloverWait(t, func() bool { return !p.CurrentReady() })
	select {
	case <-entered:
		t.Fatal("new encoder before old cleanup")
	case <-time.After(60 * time.Millisecond):
	}
	first.finish()
	awaitSource(t, entered)
	// This must not wait for the held codec constructor or retain media.
	rolloverWriteSteps(t, p, 1, 49)
	if p.CurrentReady() {
		t.Fatal("historical readiness leaked into replacement")
	}
	once.Do(func() { close(release) })
	rolloverWait(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.epoch == 1 })
	rolloverWriteSteps(t, p, 50, 55)
	second.mu.Lock()
	frames := append([]rolloverTestFrame(nil), second.frames...)
	second.mu.Unlock()
	if len(frames) != 8 || frames[0].video || frames[0].at != 0 || !frames[1].video || frames[1].at != 0 || frames[7].at != 4800 {
		t.Fatal("replacement retained backlog or split audio/video timeline", frames)
	}
	if second.cfg.startSample != 0 || second.cfg.hlsEpoch != 1 || second.cfg.resourceRef != c.resourceRef {
		t.Fatal("replacement config escaped writer")
	}
	close(second.ready)
	rolloverWait(t, p.CurrentReady)
}

func TestSourceRolloverUnknownStopNeverConstructsAnotherEncoder(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	var calls atomic.Int32
	var first *rolloverTestEncoder
	p, err := newSourceProgramRolloverWithFactory(c, func(cfg sourceProgramEncoderConfig) (sourceRolloverEncoder, error) {
		calls.Add(1)
		first = rolloverEncoder(cfg)
		return first, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); awaitSource(t, p.finished) })
	first.Close()
	awaitSource(t, p.finished)
	if calls.Load() != 1 || p.CurrentReady() {
		t.Fatal("unknown termination was retried")
	}
}

func TestSourceRolloverCancellationOwnsLateConstructor(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	entered, release := make(chan struct{}), make(chan struct{})
	var first, second *rolloverTestEncoder
	var once sync.Once
	p, err := newSourceProgramRolloverWithFactory(c, func(cfg sourceProgramEncoderConfig) (sourceRolloverEncoder, error) {
		if cfg.hlsEpoch == 0 {
			first = rolloverEncoder(cfg)
			return first, nil
		}
		second = rolloverEncoder(cfg)
		close(entered)
		<-release
		return second, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { once.Do(func() { close(release) }); p.Close(); awaitSource(t, p.finished) })
	first.retry.Store(true)
	first.Close()
	awaitSource(t, entered)
	p.Close()
	select {
	case <-p.finished:
		t.Fatal("unreturned constructor falsely released")
	default:
	}
	if second.cfg.authorized() {
		t.Fatal("late constructor retained writer authority")
	}
	once.Do(func() { close(release) })
	awaitSource(t, p.finished)
	awaitSource(t, second.finished)
	if p.CurrentReady() {
		t.Fatal("late output revived cancelled owner")
	}
}

func TestSourceRolloverInvalidInputIsTerminalEvenWhileDropping(t *testing.T) {
	for _, mode := range []string{"sequence", "size", "guard", "revision", "writer"} {
		t.Run(mode, func(t *testing.T) {
			c := sourceEncoderTestConfig(t.TempDir())
			var allowed atomic.Bool
			allowed.Store(true)
			c.authorized = allowed.Load
			p, err := newSourceProgramRolloverWithFactory(c, func(cfg sourceProgramEncoderConfig) (sourceRolloverEncoder, error) { return rolloverEncoder(cfg), nil })
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { p.Close(); awaitSource(t, p.finished) })
			p.mu.Lock()
			p.accept = false
			p.mu.Unlock()
			at := int64(0)
			b := make([]byte, 3840)
			g := sourceRenderGuard{}
			switch mode {
			case "sequence":
				at = 960
			case "size":
				b = nil
			case "guard":
				g.count = 1
			case "writer":
				allowed.Store(false)
			}
			if mode == "revision" {
				err = p.WriteProgramVideo(0, 0, make([]byte, 64*36*4), g)
			} else {
				err = p.WriteProgramAudio(at, b, g)
			}
			if err == nil {
				t.Fatal("invalid dropped input accepted")
			}
			awaitSource(t, p.finished)
		})
	}
}

func TestSourceRolloverBudgetBoundsRateAndClock(t *testing.T) {
	var b sourceRolloverBudget
	now := time.Now()
	for i := 0; i < 8; i++ {
		if delay, ok := b.reserve(now.Add(time.Duration(i) * 2 * time.Second)); !ok || delay != 0 {
			t.Fatal("valid bounded start denied")
		}
	}
	if _, ok := b.reserve(now.Add(17 * time.Second)); ok {
		t.Fatal("rate budget bypassed")
	}
	if _, ok := b.reserve(now.Add(61 * time.Second)); !ok {
		t.Fatal("expired window not released")
	}
	if delay, ok := b.reserve(now.Add(61500 * time.Millisecond)); !ok || delay != 500*time.Millisecond {
		t.Fatal("minimum start spacing")
	}
	if _, ok := b.reserve(now.Add(60 * time.Second)); ok {
		t.Fatal("clock rollback accepted")
	}
	if _, ok := b.reserve(time.Time{}); ok {
		t.Fatal("zero clock accepted")
	}
}

func TestSourceRolloverDrainDeadlineQuarantinesUnreleasedOwner(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	var calls atomic.Int32
	var first *rolloverTestEncoder
	p, err := newSourceProgramRolloverWithFactory(c, func(cfg sourceProgramEncoderConfig) (sourceRolloverEncoder, error) {
		calls.Add(1)
		first = rolloverEncoder(cfg)
		first.hold = true
		return first, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { first.finish(); p.Close(); awaitSource(t, p.finished) })
	first.retry.Store(true)
	first.Close()
	select {
	case <-p.done:
	case <-time.After(4 * time.Second):
		t.Fatal("cleanup deadline did not fence owner")
	}
	select {
	case <-p.finished:
		t.Fatal("unreaped child declared free")
	default:
	}
	if calls.Load() != 1 {
		t.Fatal("cleanup failure started replacement")
	}
	first.finish()
	awaitSource(t, p.finished)
}

func TestSourceRolloverInitialErrorReapsReturnedEncoderBeforeReleasingOwner(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	out := rolloverEncoder(c)
	out.hold = true
	returned := make(chan error, 1)
	go func() {
		p, err := newSourceProgramRolloverWithFactory(c, func(sourceProgramEncoderConfig) (sourceRolloverEncoder, error) {
			return out, errors.New("partial constructor")
		})
		if p != nil || err == nil {
			returned <- errors.New("partial encoder accepted")
			return
		}
		returned <- nil
	}()
	t.Cleanup(out.finish)
	awaitSource(t, out.stop)
	select {
	case <-returned:
		t.Fatal("constructor released unreaped ownership")
	default:
	}
	out.finish()
	select {
	case err := <-returned:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("reaped constructor did not finish")
	}
}

func TestSourceRolloverConstructorDeadlineQuarantinesLateEncoder(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	entered, release := make(chan struct{}), make(chan struct{})
	var first, second *rolloverTestEncoder
	var once sync.Once
	p, err := newSourceProgramRolloverWithFactory(c, func(cfg sourceProgramEncoderConfig) (sourceRolloverEncoder, error) {
		if cfg.hlsEpoch == 0 {
			first = rolloverEncoder(cfg)
			return first, nil
		}
		second = rolloverEncoder(cfg)
		close(entered)
		<-release
		return second, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { once.Do(func() { close(release) }); p.Close(); awaitSource(t, p.finished) })
	first.retry.Store(true)
	first.Close()
	awaitSource(t, entered)
	select {
	case <-p.done:
	case <-time.After(6 * time.Second):
		t.Fatal("constructor deadline did not fence owner")
	}
	select {
	case <-p.finished:
		t.Fatal("unreturned constructor declared free")
	default:
	}
	if second.cfg.authorized() {
		t.Fatal("late constructor still authorized")
	}
	once.Do(func() { close(release) })
	awaitSource(t, p.finished)
	awaitSource(t, second.finished)
}
