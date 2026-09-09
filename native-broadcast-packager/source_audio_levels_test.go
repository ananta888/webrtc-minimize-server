package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestSourceAudioLevelsMuteDiscardsSamplesAndPreservesGain(t *testing.T) {
	m := audioMixFixture(t, 960, 2)
	a, b := audioMixInputFixture(t, m), audioMixInputFixture(t, m)
	state, err := m.Levels()
	if err != nil || state.revision != 3 || len(state.inputs) != 2 {
		t.Fatal("initial audio snapshot")
	}
	revision, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{16384, 8192, true}}}, func() bool { return true })
	if err != nil || revision != state.revision+1 {
		t.Fatal("mute failed", err)
	}
	for _, s := range []*sourceAudioMixInput{a, b} {
		if err := s.WritePCM(48000, 2, 0, audioMixPCM(960, 1000, 1000)); err != nil {
			t.Fatal(err)
		}
	}
	assertAudioMixBlock(t, m, 0, audioMixPCM(960, 1000, 1000))
	state, _ = m.Levels()
	if state.inputs[a] != (sourceAudioLevels{16384, 8192, true}) {
		t.Fatal("mute lost gain")
	}
	if _, err := m.SetLevels(revision, []sourceAudioLevelChange{{a, sourceAudioLevels{16384, 8192, false}}}, func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	// The muted block is consumed, not replayed when no new samples arrive.
	assertAudioMixBlock(t, m, 960, audioMixPCM(960, 0, 0))
	if err := a.WritePCM(48000, 2, 1920, audioMixPCM(960, 1000, 1000)); err != nil {
		t.Fatal(err)
	}
	assertAudioMixBlock(t, m, 1920, audioMixPCM(960, 500, 250))
}

func TestSourceAudioLevelsRejectWholeBatchWithoutPartialChange(t *testing.T) {
	m := audioMixFixture(t, 960, 2)
	a, b := audioMixInputFixture(t, m), audioMixInputFixture(t, m)
	foreign := audioMixInputFixture(t, audioMixFixture(t, 960, 1))
	state, _ := m.Levels()
	valid := sourceAudioLevelChange{a, sourceAudioLevels{0, 0, true}}
	for _, changes := range [][]sourceAudioLevelChange{
		nil, {valid, valid}, {valid, {b, sourceAudioLevels{-1, 0, false}}},
		{valid, {b, sourceAudioLevels{0, 32769, false}}}, {valid, {foreign, sourceAudioLevels{0, 0, true}}},
		{valid, {nil, sourceAudioLevels{0, 0, true}}}, make([]sourceAudioLevelChange, 81),
	} {
		if _, err := m.SetLevels(state.revision, changes, func() bool { return true }); err == nil {
			t.Fatal("invalid batch accepted")
		}
		after, _ := m.Levels()
		if after.revision != state.revision || after.inputs[a] != state.inputs[a] || after.inputs[b] != state.inputs[b] {
			t.Fatal("partial mutation")
		}
	}
	for _, current := range []func() bool{nil, func() bool { return false }} {
		if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{valid}, current); err == nil {
			t.Fatal("expired command applied")
		}
	}
	if _, err := m.SetLevels(state.revision-1, []sourceAudioLevelChange{valid}, func() bool { return true }); err == nil {
		t.Fatal("stale revision applied")
	}
}

func TestSourceAudioLevelsRevocationAndRevisionExhaustion(t *testing.T) {
	m := audioMixFixture(t, 960, 2)
	a := audioMixInputFixture(t, m)
	var allowed atomic.Bool
	allowed.Store(true)
	b, err := m.Add(sourceAudioMixInputConfig{left: 32768, right: 32768, authorized: allowed.Load, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }})
	if err != nil {
		t.Fatal(err)
	}
	state, _ := m.Levels()
	if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{0, 0, true}}, {b, sourceAudioLevels{0, 0, true}}}, func() bool { allowed.Store(false); return true }); err == nil {
		t.Fatal("lost source authority applied")
	}
	after, _ := m.Levels()
	if len(after.inputs) != 1 || after.revision != state.revision+1 || after.inputs[a] != state.inputs[a] {
		t.Fatal("revocation snapshot invalid")
	}
	allowed.Store(true)
	if _, err := m.SetLevels(after.revision, []sourceAudioLevelChange{{b, sourceAudioLevels{32768, 32768, false}}}, func() bool { return true }); err == nil {
		t.Fatal("source revived")
	}
	m.mu.Lock()
	m.revision = sourceAudioLevelMaxRevision
	m.mu.Unlock()
	if _, err := m.SetLevels(sourceAudioLevelMaxRevision, []sourceAudioLevelChange{{a, sourceAudioLevels{0, 0, true}}}, func() bool { return true }); err == nil {
		t.Fatal("revision wrap")
	}
	if !m.closed || m.pcmBytes != 0 {
		t.Fatal("exhaustion did not fence and wipe mixer")
	}
}

func TestSourceAudioLevelsConcurrentCASHasOneWinner(t *testing.T) {
	m := audioMixFixture(t, 960, 1)
	a := audioMixInputFixture(t, m)
	state, _ := m.Levels()
	var wg sync.WaitGroup
	var applied atomic.Int32
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{8192, 8192, false}}}, func() bool { return true }); err == nil {
				applied.Add(1)
			}
		}()
	}
	wg.Wait()
	if applied.Load() != 1 {
		t.Fatal("CAS accepted multiple writers")
	}
	a.Close()
	if _, err := m.SetLevels(state.revision+1, []sourceAudioLevelChange{{a, sourceAudioLevels{32768, 32768, false}}}, func() bool { return true }); err == nil {
		t.Fatal("closed source accepted")
	}
}

func TestSourceAudioLevelsExhaustionDuringRenderDoesNotDeliver(t *testing.T) {
	m := audioMixFixture(t, 960, 1)
	var allowed atomic.Bool
	allowed.Store(true)
	_, err := m.Add(sourceAudioMixInputConfig{left: 32768, right: 32768, authorized: allowed.Load,
		mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts), true }})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.revision = sourceAudioLevelMaxRevision
	m.mu.Unlock()
	allowed.Store(false)
	delivered := false
	if err := m.Render(func(int64, []byte) error { delivered = true; return nil }); err == nil || delivered || !m.closed {
		t.Fatal("exhausted mixer delivered output")
	}
}

func TestSourceAudioLevelsSnapshotsAndLegacyGainCannotBypassRevision(t *testing.T) {
	m := audioMixFixture(t, 960, 2)
	a := audioMixInputFixture(t, m)
	state, _ := m.Levels()
	state.inputs[a] = sourceAudioLevels{0, 0, true}
	current, _ := m.Levels()
	if current.inputs[a] != (sourceAudioLevels{32768, 32768, false}) {
		t.Fatal("snapshot mutated the mixer")
	}
	if err := a.SetGain(8192, 4096); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{0, 0, true}}}, func() bool { return true }); err == nil {
		t.Fatal("legacy gain bypassed revision")
	}
	current, _ = m.Levels()
	if current.revision != state.revision+1 {
		t.Fatal("gain revision incorrect")
	}
	b := audioMixInputFixture(t, m)
	after, _ := m.Levels()
	if after.revision != current.revision+1 {
		t.Fatal("source addition kept old selection revision")
	}
	b.Close()
	b.Close()
	afterClose, _ := m.Levels()
	if afterClose.revision != after.revision+1 {
		t.Fatal("source close revision not idempotent")
	}
}

func TestSourceAudioLevelsWriterLossFencesAndWipesSources(t *testing.T) {
	m := audioMixFixture(t, 960, 1)
	a := audioMixInputFixture(t, m)
	if err := a.WritePCM(48000, 2, 0, audioMixPCM(960, 1000, 1000)); err != nil {
		t.Fatal(err)
	}
	state, _ := m.Levels()
	m.cfg.authorized = func() bool { return false }
	if _, err := m.SetLevels(state.revision, []sourceAudioLevelChange{{a, sourceAudioLevels{0, 0, true}}}, func() bool { return true }); err == nil {
		t.Fatal("lost writer changed levels")
	}
	if !m.closed || !a.closed || m.pcmBytes != 0 || len(a.pcm) != 0 {
		t.Fatal("lost writer kept PCM")
	}
	if _, err := m.Levels(); err == nil {
		t.Fatal("lost writer exposed levels")
	}
}
