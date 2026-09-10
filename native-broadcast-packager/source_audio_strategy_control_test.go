package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func strategyFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".v2.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSourceAudioStrategyV2SharedWireAndV1Isolation(t *testing.T) {
	p, _, _, owner, _ := audioControlFixture(t)
	p.cfg.encoder.profile.Renditions = []assignmentRendition{{ID: "low", AudioBitsPerSecond: 64000}}
	raw := strategyFixture(t, "source-audio")
	r, err := p.ApplyAudioCommand(raw)
	if err != nil {
		t.Fatal(err)
	}
	var expected sourceAudioReceipt
	_ = json.Unmarshal(strategyFixture(t, "source-audio-applied"), &expected)
	if r != expected {
		t.Fatal("strategy receipt differs from shared wire")
	}
	state, err := p.QueryAudio(strategyFixture(t, "source-audio-query"))
	if err != nil {
		t.Fatal(err)
	}
	var want sourceAudioReply
	_ = json.Unmarshal(strategyFixture(t, "source-audio-state"), &want)
	if !reflect.DeepEqual(state, want) {
		t.Fatalf("strategy state mismatch: %#v / %#v", state, want)
	}
	again, err := p.ApplyAudioCommand(raw)
	if err != nil || again != r {
		t.Fatal("identical strategy replay changed revision")
	}
	if _, err := p.ApplyAudioCommand([]byte(strings.Replace(string(raw), "speech-first", "screen-first", 1))); err == nil {
		t.Fatal("same command ID changed strategy")
	}
	legacy, err := p.QueryAudio(audioControlFixtureBytes(t, "source-audio-query"))
	if err != nil || legacy.Mix != nil || legacy.Encoding != nil || legacy.Version != 1 {
		t.Fatal("v2 fields leaked into v1")
	}
	owner.Store(false)
	if _, err := p.ApplyAudioCommand(raw); err == nil {
		t.Fatal("revoked writer can replay strategy")
	}
	if _, err := p.QueryAudio(strategyFixture(t, "source-audio-query")); err == nil {
		t.Fatal("revoked writer can read strategy")
	}
}

func TestSourceAudioStrategyV2ClosedSelectionAndAtomicCAS(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	raw := strategyFixture(t, "source-audio")
	for _, strategy := range []string{"unprocessed", "balanced", "speech-first", "screen-first"} {
		p, c, _, _, source := audioControlFixture(t)
		c.Version, c.Strategy, c.Sources = 2, &strategy, []sourceProgramAudioLevel{}
		if _, err := parseSourceAudioCommand(audioControlBytes(t, c), now); err != nil {
			t.Fatal(err)
		}
		if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err != nil {
			t.Fatal(err)
		}
		if p.audio.strategy != strategy || p.audio.revision != 3 {
			t.Fatal("strategy-only CAS not applied")
		}
		c.CommandID = "aud_bbbbbbbbbbbbbbbb"
		if _, err := p.ApplyAudioCommand(audioControlBytes(t, c)); err == nil {
			t.Fatal("stale strategy CAS applied")
		}
		source.Store(false)
		state, err := p.AudioLevels()
		if err != nil || len(state.Sources) != 0 {
			t.Fatal("strategy regranted an input")
		}
	}
	for _, patch := range []map[string]any{{"strategy": nil}, {"strategy": "automatic-capture"}, {"strategy": true},
		{"version": 1}, {"version": 4}, {"sources": nil}, {"mix": map[string]any{}}, {"expiresAt": now.UnixMilli()}, {"expectedAudioRevision": 0}} {
		var value map[string]any
		_ = json.Unmarshal(raw, &value)
		for k, v := range patch {
			value[k] = v
		}
		if _, err := parseSourceAudioCommand(audioControlBytes(t, value), now); err == nil {
			t.Fatal("invalid v2 strategy accepted", patch)
		}
	}
	var absent map[string]any
	_ = json.Unmarshal(raw, &absent)
	delete(absent, "strategy")
	if _, err := parseSourceAudioCommand(audioControlBytes(t, absent), now); err == nil {
		t.Fatal("missing strategy accepted")
	}
	duplicate := strings.Replace(string(raw), `"strategy": "speech-first"`, `"strategy": "speech-first", "strat\u0065gy": "balanced"`, 1)
	if _, err := parseSourceAudioCommand([]byte(duplicate), now); err == nil {
		t.Fatal("duplicate strategy accepted")
	}
}
