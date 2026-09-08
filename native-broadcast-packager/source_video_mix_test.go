package main

import (
	"bytes"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"testing"
)

func videoMixFixture(t *testing.T, sources int) *sourceVideoMixer {
	t.Helper()
	m, err := newSourceVideoMixer(sourceVideoMixConfig{width: 64, height: 36, maxSources: sources, queueFrames: 3,
		maxRGBABytes: 64 * 36 * 4 * (1 + 3*sources), lookAheadSamples: 48000, authorized: func() bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

func videoMixInputFixture(t *testing.T, m *sourceVideoMixer, kind string) *sourceVideoMixInput {
	t.Helper()
	s, err := m.Add(sourceVideoMixInputConfig{width: 64, height: 36, kind: kind, fit: "contain", maxFrameAgeSamples: 24000,
		authorized: func() bool { return true }, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func solidVideoMix(width, height int, red, green, blue byte) []byte {
	pixels := make([]byte, width*height*4)
	for i := 0; i < len(pixels); i += 4 {
		pixels[i], pixels[i+1], pixels[i+2], pixels[i+3] = red, green, blue, 255
	}
	return pixels
}

func videoMixColor(pixels []byte, stride, x, y int) [4]byte {
	i := (y*stride + x) * 4
	return [4]byte{pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]}
}

func renderVideoMix(t *testing.T, m *sourceVideoMixer, at int64, inspect func([]byte)) {
	t.Helper()
	var borrowed []byte
	if err := m.Render(at, func(ts int64, revision uint64, pixels []byte) error {
		if ts != at || revision != m.revision || len(pixels) != m.cfg.width*m.cfg.height*4 {
			t.Fatal("invalid compositor output scope")
		}
		borrowed = pixels
		inspect(pixels)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(borrowed, make([]byte, len(borrowed))) {
		t.Fatal("borrowed composed pixels retained")
	}
}

func setVideoMixScene(t *testing.T, m *sourceVideoMixer, layout string, inputs []*sourceVideoMixInput, active *sourceVideoMixInput) {
	t.Helper()
	before := m.revision
	if revision, err := m.SetScene(before, layout, inputs, active); err != nil || revision != before+1 {
		t.Fatal("scene change rejected", err)
	}
}

func TestSourceVideoMixerAdmission(t *testing.T) {
	valid := sourceVideoMixConfig{width: 64, height: 36, maxSources: 1, queueFrames: 3, maxRGBABytes: 64 * 36 * 16,
		lookAheadSamples: 48000, authorized: func() bool { return true }}
	for _, mutate := range []func(*sourceVideoMixConfig){
		func(c *sourceVideoMixConfig) { c.width = 31 },
		func(c *sourceVideoMixConfig) { c.height = 18 },
		func(c *sourceVideoMixConfig) { c.width = 1922 },
		func(c *sourceVideoMixConfig) { c.height = 1082 },
		func(c *sourceVideoMixConfig) { c.maxSources = 0 },
		func(c *sourceVideoMixConfig) { c.maxSources = 81 },
		func(c *sourceVideoMixConfig) { c.queueFrames = 1 },
		func(c *sourceVideoMixConfig) { c.queueFrames = 9 },
		func(c *sourceVideoMixConfig) { c.maxRGBABytes = 1 },
		func(c *sourceVideoMixConfig) { c.maxRGBABytes = 256*1024*1024 + 1 },
		func(c *sourceVideoMixConfig) { c.lookAheadSamples = 959 },
		func(c *sourceVideoMixConfig) { c.lookAheadSamples = 48001 },
		func(c *sourceVideoMixConfig) { c.startSample = -1 },
		func(c *sourceVideoMixConfig) { c.startSample = math.MaxInt64 },
		func(c *sourceVideoMixConfig) { c.authorized = nil },
		func(c *sourceVideoMixConfig) { c.authorized = func() bool { return false } },
	} {
		cfg := valid
		mutate(&cfg)
		if m, err := newSourceVideoMixer(cfg); m != nil || err == nil {
			t.Fatal("invalid compositor admitted")
		}
	}
	m := videoMixFixture(t, 1)
	validInput := sourceVideoMixInputConfig{width: 64, height: 36, kind: "camera", fit: "cover", maxFrameAgeSamples: 24000,
		authorized: func() bool { return true }, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }}
	for _, mutate := range []func(*sourceVideoMixInputConfig){
		func(c *sourceVideoMixInputConfig) { c.width = 1 },
		func(c *sourceVideoMixInputConfig) { c.height = 1082 },
		func(c *sourceVideoMixInputConfig) { c.kind = "microphone" },
		func(c *sourceVideoMixInputConfig) { c.fit = "unknown" },
		func(c *sourceVideoMixInputConfig) { c.maxFrameAgeSamples = 4799 },
		func(c *sourceVideoMixInputConfig) { c.maxFrameAgeSamples = 1440001 },
		func(c *sourceVideoMixInputConfig) { c.mapTimestamp = nil },
		func(c *sourceVideoMixInputConfig) { c.authorized = nil },
		func(c *sourceVideoMixInputConfig) { c.authorized = func() bool { return false } },
	} {
		cfg := validInput
		mutate(&cfg)
		if s, err := m.Add(cfg); s != nil || err == nil || m.usedBytes != len(m.output) {
			t.Fatal("invalid source reserved pixels")
		}
	}
	m.cfg.maxRGBABytes--
	if s, err := m.Add(validInput); s != nil || err == nil || m.usedBytes != len(m.output) {
		t.Fatal("pixel budget exceeded")
	}
	m.cfg.maxRGBABytes++
	s := videoMixInputFixture(t, m, "camera")
	if input, err := m.Add(validInput); input != nil || err == nil {
		t.Fatal("source budget exceeded")
	}
	if err := s.WriteRGBA(64, 36, 0, solidVideoMix(64, 36, 255, 0, 0)); err != nil {
		t.Fatal(err)
	}
	retained := s.frames[0].pixels
	s.Close()
	s.Close()
	if !bytes.Equal(retained, make([]byte, len(retained))) || s.frames != nil || s.cfg.mapTimestamp != nil || m.usedBytes != len(m.output) {
		t.Fatal("source did not wipe and release pixels")
	}
	videoMixInputFixture(t, m, "camera")
	if err := s.WriteRGBA(64, 36, 1, solidVideoMix(64, 36, 1, 2, 3)); err == nil {
		t.Fatal("old source handle resurrected")
	}
}

func TestSourceVideoMixerSceneCASAndScope(t *testing.T) {
	m, other := videoMixFixture(t, 2), videoMixFixture(t, 1)
	a, b, foreign := videoMixInputFixture(t, m, "camera"), videoMixInputFixture(t, m, "screen"), videoMixInputFixture(t, other, "camera")
	setVideoMixScene(t, m, "grid", []*sourceVideoMixInput{a, b}, nil)
	for _, tc := range []struct {
		revision uint64
		layout   string
		inputs   []*sourceVideoMixInput
		active   *sourceVideoMixInput
	}{
		{1, "single", []*sourceVideoMixInput{a}, nil},
		{2, "unknown", []*sourceVideoMixInput{a}, nil},
		{2, "single", []*sourceVideoMixInput{foreign}, nil},
		{2, "single", []*sourceVideoMixInput{a, a}, nil},
		{2, "single", []*sourceVideoMixInput{nil}, nil},
		{2, "single", []*sourceVideoMixInput{a}, b},
		{2, "grid", []*sourceVideoMixInput{a, b}, a},
		{2, "single", []*sourceVideoMixInput{&sourceVideoMixInput{mixer: m}}, nil},
		{2, "grid", make([]*sourceVideoMixInput, 21), nil},
	} {
		if revision, err := m.SetScene(tc.revision, tc.layout, tc.inputs, tc.active); err == nil || revision != 2 || m.layout != "grid" {
			t.Fatal("invalid scene mutated layout or revision")
		}
	}
	inputs := []*sourceVideoMixInput{a, b}
	setVideoMixScene(t, m, "single", inputs, b)
	inputs[0] = foreign
	if m.scene[0] != a {
		t.Fatal("scene retained mutable caller list")
	}
	b.Close()
	if m.scene[1] != nil || m.revision != 3 {
		t.Fatal("revoke retained source or altered independent scene revision")
	}
	if _, err := m.SetScene(3, "single", []*sourceVideoMixInput{b}, nil); err == nil {
		t.Fatal("revoked source selected again")
	}
	m.revision = sourceVideoSceneMaxRevision
	if _, err := m.SetScene(m.revision, "single", []*sourceVideoMixInput{a}, nil); err == nil {
		t.Fatal("scene revision overflow")
	}
}

func TestSourceVideoMixerFutureDropsFreshnessAndRevoke(t *testing.T) {
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "camera")
	setVideoMixScene(t, m, "single", []*sourceVideoMixInput{s}, nil)
	for _, entry := range []struct {
		at    uint32
		color byte
	}{{0, 100}, {1600, 120}, {3200, 140}} {
		if err := s.WriteRGBA(64, 36, entry.at, solidVideoMix(64, 36, entry.color, 0, 0)); err != nil {
			t.Fatal(err)
		}
	}
	assertColor := func(red byte) func([]byte) {
		return func(pixels []byte) {
			if got := videoMixColor(pixels, 64, 0, 0); got != [4]byte{red, 0, 0, 255} {
				t.Fatalf("unexpected presented frame %v", got)
			}
		}
	}
	renderVideoMix(t, m, 0, assertColor(100))
	// Fixed pool is full. The presented image stays; oldest pending is dropped.
	if err := s.WriteRGBA(64, 36, 4800, solidVideoMix(64, 36, 160, 0, 0)); err != nil {
		t.Fatal(err)
	}
	renderVideoMix(t, m, 1600, assertColor(100))
	renderVideoMix(t, m, 3200, assertColor(140))
	renderVideoMix(t, m, 4800, assertColor(160))
	renderVideoMix(t, m, 28801, func(pixels []byte) {
		if !bytes.Equal(pixels, solidVideoMix(64, 36, 9, 19, 31)) || s.current != -1 || s.closed {
			t.Fatal("stale image did not become a reusable slate")
		}
	})
	// A stale arriving frame is discarded without stealing a pool slot.
	if err := s.WriteRGBA(64, 36, 4801, solidVideoMix(64, 36, 170, 0, 0)); err != nil || len(s.pending) != 0 {
		t.Fatal("late frame shifted to present")
	}
	input := solidVideoMix(64, 36, 180, 0, 0)
	if err := s.WriteRGBA(64, 36, 30000, input); err != nil {
		t.Fatal(err)
	}
	clear(input)
	renderVideoMix(t, m, 30000, assertColor(180))
	s.Close()
	renderVideoMix(t, m, 31600, func(pixels []byte) {
		if !bytes.Equal(pixels, solidVideoMix(64, 36, 9, 19, 31)) {
			t.Fatal("revoked image survived into next output")
		}
	})
}

func TestSourceVideoMixerInputDenialsAreLocal(t *testing.T) {
	for _, mode := range []string{"shape", "length", "duplicate", "reverse", "future", "negative", "overflow", "unknown-clock", "policy"} {
		t.Run(mode, func(t *testing.T) {
			m := videoMixFixture(t, 2)
			a, b := videoMixInputFixture(t, m, "camera"), videoMixInputFixture(t, m, "camera")
			if err := a.WriteRGBA(64, 36, 100, solidVideoMix(64, 36, 255, 0, 0)); err != nil {
				t.Fatal(err)
			}
			width, at, pixels := 64, uint32(200), solidVideoMix(64, 36, 255, 0, 0)
			switch mode {
			case "shape":
				width = 66
			case "length":
				pixels = pixels[:len(pixels)-1]
			case "duplicate":
				at = 100
			case "reverse":
				at = 99
			case "future":
				at = 48001
			case "negative":
				a.cfg.mapTimestamp = func(uint32) (int64, bool) { return -1, true }
			case "overflow":
				a.cfg.mapTimestamp = func(uint32) (int64, bool) { return math.MaxInt64, true }
			case "unknown-clock":
				a.cfg.mapTimestamp = func(uint32) (int64, bool) { return 200, false }
			case "policy":
				a.cfg.authorized = func() bool { return false }
			}
			if err := a.WriteRGBA(width, 36, at, pixels); err == nil || !a.closed || b.closed || m.closed {
				t.Fatal("source error was not isolated")
			}
		})
	}
}

func TestSourceVideoMixerTerminalOutput(t *testing.T) {
	for _, mode := range []string{"time", "nil", "policy", "failure", "late-policy"} {
		t.Run(mode, func(t *testing.T) {
			m := videoMixFixture(t, 1)
			s := videoMixInputFixture(t, m, "camera")
			calls, at := 0, int64(0)
			consume := func(int64, uint64, []byte) error { calls++; return errors.New("private fixture detail") }
			switch mode {
			case "time":
				at = -1
			case "nil":
				consume = nil
			case "policy":
				m.cfg.authorized = func() bool { return false }
			case "late-policy":
				allowed := true
				m.cfg.authorized = func() bool { return allowed }
				s.cfg.authorized = func() bool { allowed = false; return true }
			}
			if err := m.Render(at, consume); err == nil || !m.closed || !s.closed || m.usedBytes != 0 || m.output != nil {
				t.Fatal("invalid output not terminal")
			}
			if mode != "failure" && calls != 0 {
				t.Fatal("unauthorized output handoff")
			}
		})
	}
}

func TestSourceVideoMixerConcurrentStop(t *testing.T) {
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "camera")
	setVideoMixScene(t, m, "single", []*sourceVideoMixInput{s}, nil)
	var stopped atomic.Bool
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		for i := 0; i < 40; i++ {
			_ = s.WriteRGBA(64, 36, uint32(i*800), solidVideoMix(64, 36, 255, 0, 0))
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 40; i++ {
			_ = m.Render(int64(i*800), func(_ int64, _ uint64, pixels []byte) error {
				if stopped.Load() && !bytes.Equal(pixels, solidVideoMix(64, 36, 9, 19, 31)) {
					t.Error("output after completed revoke")
				}
				return nil
			})
		}
	}()
	go func() { defer workers.Done(); s.Close(); stopped.Store(true) }()
	workers.Wait()
	if !s.closed || s.frames != nil || m.usedBytes != len(m.output) {
		t.Fatal("concurrent stop retained pixels")
	}
}
