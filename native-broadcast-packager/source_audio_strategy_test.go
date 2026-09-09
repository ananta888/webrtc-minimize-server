package main

import (
	"encoding/binary"
	"math"
	"sync"
	"sync/atomic"
	"testing"
)

func strategyInput(t *testing.T, m *sourceAudioMixer, kind string) *sourceAudioMixInput {
	t.Helper()
	s, err := m.Add(sourceAudioMixInputConfig{left: 32768, right: 32768, kind: kind,
		authorized: func() bool { return true }, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func strategyBlock(t *testing.T, m *sourceAudioMixer, a, b *sourceAudioMixInput, mic, screen int16) []int16 {
	t.Helper()
	for _, input := range []struct {
		s     *sourceAudioMixInput
		value int16
	}{{a, mic}, {b, screen}} {
		if input.s != nil {
			if err := input.s.WritePCM(48000, 2, uint32(m.cursor), audioMixPCM(960, input.value, input.value)); err != nil {
				t.Fatal(err)
			}
		}
	}
	var values []int16
	if err := m.Render(func(_ int64, pcm []byte) error {
		values = make([]int16, len(pcm)/2)
		for i := range values {
			values[i] = int16(binary.LittleEndian.Uint16(pcm[i*2:]))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return values
}

func setStrategy(t *testing.T, m *sourceAudioMixer, strategy string) {
	t.Helper()
	state, err := m.Levels()
	if err != nil {
		t.Fatal(err)
	}
	if revision, err := m.SetLevelsStrategy(state.revision, nil, strategy, func() bool { return true }); err != nil || revision != state.revision+1 {
		t.Fatal("strategy CAS", err)
	}
}

func TestSourceAudioStrategiesDuckOnlyTheLowerPriorityKind(t *testing.T) {
	for _, profile := range []struct {
		id   string
		want int16
	}{{"unprocessed", 10000}, {"balanced", 7500}, {"speech-first", 6400}, {"screen-first", 6400}} {
		t.Run(profile.id, func(t *testing.T) {
			m := audioMixFixture(t, 960, 2)
			a, b := strategyInput(t, m, "microphone"), strategyInput(t, m, "screen-audio")
			setStrategy(t, m, profile.id)
			first := strategyBlock(t, m, a, b, 5000, 5000)
			// Attack traverses the current block; it must not step all samples.
			if profile.id != "unprocessed" && first[0] <= first[len(first)-1] {
				t.Fatal("attack did not ramp")
			}
			steady := strategyBlock(t, m, a, b, 5000, 5000)
			for _, value := range steady {
				if math.Abs(float64(value-profile.want)) > 1 {
					t.Fatal("wrong steady mix", value, profile.want)
				}
			}
			state, _ := m.Levels()
			if state.strategy != profile.id || state.dynamics.limiter != 1 {
				t.Fatal("strategy state or unintended limiting")
			}
			if profile.id == "speech-first" && (state.dynamics.microphone != 1 || state.dynamics.screen != .28) {
				t.Fatal("speech priority inverted")
			}
			if profile.id == "screen-first" && (state.dynamics.screen != 1 || state.dynamics.microphone != .28) {
				t.Fatal("screen priority inverted")
			}
		})
	}
}

func TestSourceAudioStrategiesMuteCannotTriggerDuckingOrReplay(t *testing.T) {
	m := audioMixFixture(t, 960, 2)
	a, b := strategyInput(t, m, "microphone"), strategyInput(t, m, "screen-audio")
	setStrategy(t, m, "speech-first")
	strategyBlock(t, m, a, b, 5000, 5000)
	strategyBlock(t, m, a, b, 5000, 5000)
	state, _ := m.Levels()
	if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{32768, 32768, true}}}, func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	last := 0.28
	for i := 0; i < 70; i++ {
		strategyBlock(t, m, a, b, 10000, 5000)
		state, _ = m.Levels()
		if state.dynamics.screen <= last || state.dynamics.screen >= 1 {
			t.Fatal("muted mic or unsmoothed release", state.dynamics.screen)
		}
		last = state.dynamics.screen
	}
	if last < .99 {
		t.Fatal("release did not recover")
	}
	if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{32768, 32768, false}}}, func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	for _, value := range strategyBlock(t, m, nil, nil, 0, 0) {
		if value != 0 {
			t.Fatal("muted PCM replayed")
		}
	}
}

func TestSourceAudioStrategyLimiterLinksStereoWithoutClippingOrExtraBuffers(t *testing.T) {
	m := audioMixFixture(t, 960, 80)
	setStrategy(t, m, "balanced")
	for i := 0; i < 80; i++ {
		s := strategyInput(t, m, "")
		if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, 30000, -15000)); err != nil {
			t.Fatal(err)
		}
	}
	before := m.pcmBytes
	if err := m.Render(func(_ int64, pcm []byte) error {
		for i := 0; i < len(pcm); i += 4 {
			left, right := int16(binary.LittleEndian.Uint16(pcm[i:])), int16(binary.LittleEndian.Uint16(pcm[i+2:]))
			if left > 29490 || left < 29489 || math.Abs(float64(int(left)+2*int(right))) > 1 {
				t.Fatal("limiter clipped or moved stereo image", left, right)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if m.pcmBytes != before || m.dynamics.peak > 29490 || m.dynamics.limiter >= 1 {
		t.Fatal("limiter state or memory")
	}
	m.Close()
	if m.dynamics != (sourceAudioDynamics{}) || m.pcmBytes != 0 {
		t.Fatal("closed dynamics retained")
	}
}

func TestSourceAudioStrategyCASIsAtomicAndCannotRegrant(t *testing.T) {
	m := audioMixFixture(t, 960, 2)
	a := strategyInput(t, m, "microphone")
	state, _ := m.Levels()
	for _, profile := range []string{"", "PRIVATE", "speech"} {
		if _, err := m.SetLevelsStrategy(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{0, 0, true}}}, profile, func() bool { return true }); err == nil {
			t.Fatal("unknown strategy")
		}
	}
	if _, err := m.SetLevelsStrategy(state.revision, nil, "balanced", func() bool { return false }); err == nil {
		t.Fatal("expired strategy")
	}
	after, _ := m.Levels()
	if after.revision != state.revision || after.strategy != "unprocessed" || after.inputs[a] != state.inputs[a] {
		t.Fatal("partial strategy mutation")
	}
	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := m.SetLevelsStrategy(state.revision, nil, "speech-first", func() bool { return true }); err == nil {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatal("multiple strategy CAS winners")
	}
	a.Close()
	after, _ = m.Levels()
	if _, err := m.SetLevelsStrategy(after.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{32768, 32768, false}}}, "balanced", func() bool { return true }); err == nil {
		t.Fatal("strategy revived source")
	}
}

func TestSourceAudioStrategiesUsePostGainThresholdAndExcludeUnknownKinds(t *testing.T) {
	for _, input := range []struct {
		name, kind string
		gain       int
		level      int16
		wantDuck   bool
	}{
		{"below", "microphone", 32768, 1474, false},
		{"at-threshold", "microphone", 32768, 1475, true},
		{"zero-gain", "microphone", 0, 30000, false},
		{"reduced-gain", "microphone", 16384, 2800, false},
		{"generic-local", "", 32768, 5000, false},
	} {
		t.Run(input.name, func(t *testing.T) {
			m := audioMixFixture(t, 960, 2)
			a, b := strategyInput(t, m, input.kind), strategyInput(t, m, "screen-audio")
			if err := a.SetGain(input.gain, input.gain); err != nil {
				t.Fatal(err)
			}
			setStrategy(t, m, "speech-first")
			strategyBlock(t, m, a, b, input.level, 5000)
			want := 1.0
			if input.wantDuck {
				want = .28
			}
			if m.dynamics.screen != want {
				t.Fatal("sidechain ignored gain/kind/threshold", m.dynamics.screen)
			}
		})
	}
}

func TestSourceAudioStrategyUnprocessedImmediatelyResetsDynamicsAndV1KeepsStrategy(t *testing.T) {
	m := audioMixFixture(t, 960, 2)
	a, b := strategyInput(t, m, "microphone"), strategyInput(t, m, "screen-audio")
	setStrategy(t, m, "speech-first")
	strategyBlock(t, m, a, b, 30000, 30000)
	if m.dynamics.screen != .28 || m.dynamics.limiter >= 1 {
		t.Fatal("fixture did not duck and limit")
	}
	state, _ := m.Levels()
	if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{32768, 32768, false}}}, func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	if m.strategy != "speech-first" {
		t.Fatal("v1 gain control reset strategy")
	}
	setStrategy(t, m, "unprocessed")
	state, _ = m.Levels()
	if state.dynamics.microphone != 1 || state.dynamics.screen != 1 || state.dynamics.limiter != 1 {
		t.Fatal("stale dynamics after unprocessed selection")
	}
	for _, value := range strategyBlock(t, m, a, b, 5000, 5000) {
		if value != 10000 {
			t.Fatal("unprocessed retained attenuation", value)
		}
	}
}
