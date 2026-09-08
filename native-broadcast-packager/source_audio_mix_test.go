package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"testing"
)

func audioMixFixture(t *testing.T, capacity, sources int) *sourceAudioMixer {
	t.Helper()
	m, err := newSourceAudioMixer(sourceAudioMixConfig{maxSources: sources, queueSamples: capacity,
		maxPCMBytes: capacity * sources * 4, authorized: func() bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

func audioMixInputFixture(t *testing.T, m *sourceAudioMixer) *sourceAudioMixInput {
	t.Helper()
	s, err := m.Add(sourceAudioMixInputConfig{left: 32768, right: 32768, authorized: func() bool { return true },
		mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func audioMixPCM(samples int, left, right int16) []byte {
	pcm := make([]byte, samples*4)
	for i := 0; i < samples; i++ {
		binary.LittleEndian.PutUint16(pcm[i*4:], uint16(left))
		binary.LittleEndian.PutUint16(pcm[i*4+2:], uint16(right))
	}
	return pcm
}

func assertAudioMixBlock(t *testing.T, m *sourceAudioMixer, start int64, expected []byte) {
	t.Helper()
	var borrowed []byte
	if err := m.Render(func(at int64, pcm []byte) error {
		borrowed = pcm
		if at != start || len(pcm) != 960*4 || !bytes.Equal(pcm, expected) {
			t.Fatal("unexpected program time or mixed PCM")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(borrowed, make([]byte, len(borrowed))) {
		t.Fatal("borrowed output not wiped")
	}
}

func TestSourceAudioMixerAdmission(t *testing.T) {
	valid := sourceAudioMixConfig{maxSources: 2, queueSamples: 960, maxPCMBytes: 960 * 8, authorized: func() bool { return true }}
	for _, mutate := range []func(*sourceAudioMixConfig){
		func(c *sourceAudioMixConfig) { c.maxSources = 0 },
		func(c *sourceAudioMixConfig) { c.maxSources = 81 },
		func(c *sourceAudioMixConfig) { c.queueSamples = 959 },
		func(c *sourceAudioMixConfig) { c.queueSamples = 48001 },
		func(c *sourceAudioMixConfig) { c.queueSamples = 961 },
		func(c *sourceAudioMixConfig) { c.maxPCMBytes = 3839 },
		func(c *sourceAudioMixConfig) { c.maxPCMBytes = 80*48000*4 + 1 },
		func(c *sourceAudioMixConfig) { c.authorized = nil },
		func(c *sourceAudioMixConfig) { c.authorized = func() bool { return false } },
		func(c *sourceAudioMixConfig) { c.startSample = -1 },
		func(c *sourceAudioMixConfig) { c.startSample = math.MaxInt64 },
	} {
		cfg := valid
		mutate(&cfg)
		if m, err := newSourceAudioMixer(cfg); m != nil || err == nil {
			t.Fatal("invalid mixer admitted")
		}
	}
	m := audioMixFixture(t, 960, 2)
	validInput := sourceAudioMixInputConfig{left: 32768, right: 32768, authorized: func() bool { return true },
		mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }}
	for _, mutate := range []func(*sourceAudioMixInputConfig){
		func(c *sourceAudioMixInputConfig) { c.authorized = nil },
		func(c *sourceAudioMixInputConfig) { c.authorized = func() bool { return false } },
		func(c *sourceAudioMixInputConfig) { c.mapTimestamp = nil },
		func(c *sourceAudioMixInputConfig) { c.left = -1 },
		func(c *sourceAudioMixInputConfig) { c.right = 32769 },
	} {
		cfg := validInput
		mutate(&cfg)
		if s, err := m.Add(cfg); s != nil || err == nil || m.pcmBytes != 0 {
			t.Fatal("invalid source reserved PCM")
		}
	}
	s := audioMixInputFixture(t, m)
	m.cfg.maxPCMBytes = 960 * 4 // Independently exercise the byte ceiling.
	if input, err := m.Add(validInput); input != nil || err == nil || m.pcmBytes != 960*4 {
		t.Fatal("PCM budget exceeded")
	}
	m.cfg.maxPCMBytes = 960 * 8
	audioMixInputFixture(t, m)
	if input, err := m.Add(validInput); input != nil || err == nil {
		t.Fatal("source budget exceeded")
	}
	retained := s.pcm
	if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, 1000, -1000)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s.Close()
	for _, sample := range retained {
		if sample != 0 {
			t.Fatal("closed source retained PCM")
		}
	}
	if s.pcm != nil || s.cfg.mapTimestamp != nil || m.pcmBytes != 960*4 {
		t.Fatal("source reservation or clock references survived close")
	}
	audioMixInputFixture(t, m) // A fresh handle may use released capacity.
	if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, 1, 1)); err == nil {
		t.Fatal("old source generation resurrected")
	}
}

func TestSourceAudioMixerStereoGainAndSaturation(t *testing.T) {
	m := audioMixFixture(t, 1920, 3)
	a, b, c := audioMixInputFixture(t, m), audioMixInputFixture(t, m), audioMixInputFixture(t, m)
	for _, s := range []*sourceAudioMixInput{a, b, c} {
		if err := s.WritePCM(48000, 2, 0, audioMixPCM(1920, 30000, -30000)); err != nil {
			t.Fatal(err)
		}
	}
	assertAudioMixBlock(t, m, 0, audioMixPCM(960, 32767, -32768))
	if err := a.SetGain(16384, 8192); err != nil {
		t.Fatal(err)
	}
	if err := a.SetGain(-1, 32768); err == nil || a.closed {
		t.Fatal("invalid gain mutated source")
	}
	b.Close()
	c.Close()
	assertAudioMixBlock(t, m, 960, audioMixPCM(960, 15000, -7500))
	assertAudioMixBlock(t, m, 1920, audioMixPCM(960, 0, 0)) // No replay of consumed samples.
}

func TestSourceAudioMixerGapLateDataAndRingWrap(t *testing.T) {
	m := audioMixFixture(t, 1920, 1)
	s := audioMixInputFixture(t, m)
	input := audioMixPCM(120, 200, -300)
	if err := s.WritePCM(48000, 2, 120, input); err != nil {
		t.Fatal(err)
	}
	clear(input) // Mixer owns its bounded copy.
	want := audioMixPCM(960, 0, 0)
	copy(want[120*4:], audioMixPCM(120, 200, -300))
	assertAudioMixBlock(t, m, 0, want)
	if err := s.WritePCM(48000, 2, 840, audioMixPCM(240, 400, -500)); err != nil {
		t.Fatal(err)
	}
	clear(want)
	copy(want, audioMixPCM(120, 400, -500)) // Only not-yet-played half survives.
	assertAudioMixBlock(t, m, 960, want)
	for i := int64(1920); i < 1920*20; i += 960 {
		if err := s.WritePCM(48000, 2, uint32(i), audioMixPCM(960, int16(i), -int16(i))); err != nil {
			t.Fatal(err)
		}
		assertAudioMixBlock(t, m, i, audioMixPCM(960, int16(i), -int16(i)))
	}
}

func TestSourceAudioMixerMappedWrapAndMute(t *testing.T) {
	m := audioMixFixture(t, 1920, 1)
	s := audioMixInputFixture(t, m)
	base := uint32(0xfffffe00)
	s.cfg.mapTimestamp = func(ts uint32) (int64, bool) { return int64(ts - base), true }
	if err := s.SetGain(0, 0); err != nil {
		t.Fatal(err)
	}
	if err := s.WritePCM(48000, 2, base, audioMixPCM(1920, 100, -100)); err != nil {
		t.Fatal(err)
	}
	assertAudioMixBlock(t, m, 0, audioMixPCM(960, 0, 0))
	if err := s.SetGain(32768, 32768); err != nil {
		t.Fatal(err)
	}
	assertAudioMixBlock(t, m, 960, audioMixPCM(960, 100, -100))
	if err := s.WritePCM(48000, 2, base+1920, audioMixPCM(960, 200, -200)); err != nil {
		t.Fatal(err)
	}
	assertAudioMixBlock(t, m, 1920, audioMixPCM(960, 200, -200))
	assertAudioMixBlock(t, m, 2880, audioMixPCM(960, 0, 0))
}

func TestSourceAudioMixerAccumulatesBeforeClipping(t *testing.T) {
	m := audioMixFixture(t, 960, 80)
	// 79 opposing contributions plus a single audible source. Clipping each
	// contribution before completing the sum would make map order audible.
	for i := 0; i < 79; i++ {
		s := audioMixInputFixture(t, m)
		value := int16(30000)
		if i%2 == 1 {
			value = -value
		}
		if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, value, -value)); err != nil {
			t.Fatal(err)
		}
	}
	s := audioMixInputFixture(t, m)
	if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, -29900, 29900)); err != nil {
		t.Fatal(err)
	}
	assertAudioMixBlock(t, m, 0, audioMixPCM(960, 100, -100))
	m.Close()
	if m.pcmBytes != 0 || len(m.sources) != 0 {
		t.Fatal("whole mixer did not release reservations")
	}
}

func TestSourceAudioMixerInputDenialIsSourceLocal(t *testing.T) {
	for _, test := range []struct {
		name string
		fail func(*sourceAudioMixInput) error
	}{
		{"rate", func(s *sourceAudioMixInput) error { return s.WritePCM(44100, 2, 960, make([]byte, 4)) }},
		{"channels", func(s *sourceAudioMixInput) error { return s.WritePCM(48000, 1, 960, make([]byte, 4)) }},
		{"empty", func(s *sourceAudioMixInput) error { return s.WritePCM(48000, 2, 960, nil) }},
		{"unaligned", func(s *sourceAudioMixInput) error { return s.WritePCM(48000, 2, 960, make([]byte, 3)) }},
		{"oversize", func(s *sourceAudioMixInput) error { return s.WritePCM(48000, 2, 960, make([]byte, 5761*4)) }},
		{"future", func(s *sourceAudioMixInput) error { return s.WritePCM(48000, 2, 48000, make([]byte, 4)) }},
		{"overlap", func(s *sourceAudioMixInput) error { return s.WritePCM(48000, 2, 959, make([]byte, 4)) }},
		{"unknown-clock", func(s *sourceAudioMixInput) error {
			s.cfg.mapTimestamp = func(uint32) (int64, bool) { return 960, false }
			return s.WritePCM(48000, 2, 960, make([]byte, 4))
		}},
		{"negative-clock", func(s *sourceAudioMixInput) error {
			s.cfg.mapTimestamp = func(uint32) (int64, bool) { return -1, true }
			return s.WritePCM(48000, 2, 960, make([]byte, 4))
		}},
		{"overflow-clock", func(s *sourceAudioMixInput) error {
			s.cfg.mapTimestamp = func(uint32) (int64, bool) { return math.MaxInt64, true }
			return s.WritePCM(48000, 2, 960, make([]byte, 4))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			m := audioMixFixture(t, 48000, 2)
			a, b := audioMixInputFixture(t, m), audioMixInputFixture(t, m)
			for _, s := range []*sourceAudioMixInput{a, b} {
				if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, 1, 2)); err != nil {
					t.Fatal(err)
				}
			}
			if err := test.fail(a); err == nil || !a.closed || m.closed || b.closed {
				t.Fatal("invalid source was not isolated")
			}
			assertAudioMixBlock(t, m, 0, audioMixPCM(960, 1, 2))
		})
	}
}

func TestSourceAudioMixerRevocationAndOutputFailure(t *testing.T) {
	for _, mode := range []string{"source-policy", "writer-policy", "writer-error", "nil-output"} {
		t.Run(mode, func(t *testing.T) {
			m := audioMixFixture(t, 960, 1)
			s := audioMixInputFixture(t, m)
			if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, 5, 5)); err != nil {
				t.Fatal(err)
			}
			retained := s.pcm
			calls := 0
			consume := func(_ int64, pcm []byte) error {
				calls++
				if mode == "writer-error" {
					return errors.New("synthetic private data must not escape")
				}
				if !bytes.Equal(pcm, audioMixPCM(960, 0, 0)) {
					t.Fatal("revoked source output")
				}
				return nil
			}
			switch mode {
			case "source-policy":
				s.cfg.authorized = func() bool { return false }
			case "writer-policy":
				m.cfg.authorized = func() bool { return false }
			case "nil-output":
				consume = nil
			}
			err := m.Render(consume)
			if (err == nil) != (mode == "source-policy") || !s.closed {
				t.Fatal("terminal boundary differs")
			}
			if (mode == "writer-policy" || mode == "nil-output") && calls != 0 {
				t.Fatal("unauthorized output callback")
			}
			for _, sample := range retained {
				if sample != 0 {
					t.Fatal("revoked PCM retained")
				}
			}
		})
	}
}

func TestSourceAudioMixerConcurrentStop(t *testing.T) {
	m := audioMixFixture(t, 48000, 1)
	s := audioMixInputFixture(t, m)
	var stopped atomic.Bool
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		for i := 0; i < 40; i++ {
			_ = s.WritePCM(48000, 2, uint32(i*960), audioMixPCM(960, 1, 1))
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 40; i++ {
			_ = m.Render(func(_ int64, pcm []byte) error {
				if stopped.Load() && !bytes.Equal(pcm, audioMixPCM(960, 0, 0)) {
					t.Error("output after completed source stop")
				}
				return nil
			})
		}
	}()
	go func() { defer workers.Done(); s.Close(); stopped.Store(true) }()
	workers.Wait()
	if !s.closed || s.pcm != nil || m.pcmBytes != 0 {
		t.Fatal("concurrent stop did not release samples")
	}
}

func TestSourceAudioMixerRechecksWriterBeforeHandoff(t *testing.T) {
	m := audioMixFixture(t, 960, 1)
	s := audioMixInputFixture(t, m)
	allowed := true
	m.cfg.authorized = func() bool { return allowed }
	s.cfg.authorized = func() bool { allowed = false; return true }
	calls := 0
	if err := m.Render(func(int64, []byte) error { calls++; return nil }); err == nil || calls != 0 || !m.closed || !s.closed {
		t.Fatal("lost writer policy survived mix computation")
	}
}
