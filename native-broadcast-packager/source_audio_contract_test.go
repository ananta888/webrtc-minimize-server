package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func audioControlBytes(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func audioControlFixtureBytes(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".v1.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSourceAudioContractSharedFixturesAndBounds(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	raw := audioControlFixtureBytes(t, "source-audio")
	c, err := parseSourceAudioCommand(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseSourceAudioQuery(audioControlFixtureBytes(t, "source-audio-query"), now); err != nil {
		t.Fatal(err)
	}
	for _, bound := range []int{0, 32768} {
		c.Sources[0].Left, c.Sources[0].Right = bound, bound
		if _, err := parseSourceAudioCommand(audioControlBytes(t, c), now); err != nil {
			t.Fatal(err)
		}
	}
	c.Sources = nil
	for i := 0; i < 80; i++ {
		c.Sources = append(c.Sources, sourceProgramAudioLevel{fmt.Sprintf("sls_%016x", i), 32768, 32768, false})
	}
	if _, err := parseSourceAudioCommand(audioControlBytes(t, c), now); err != nil {
		t.Fatal("80 source contract rejected", err)
	}
	c.Sources = append(c.Sources, sourceProgramAudioLevel{"sls_zzzzzzzzzzzzzzzz", 0, 0, true})
	if _, err := parseSourceAudioCommand(audioControlBytes(t, c), now); err == nil {
		t.Fatal("81 source contract accepted")
	}
	for _, at := range []int64{0, 1800000004000, 1799999998999, 9007199254740992} {
		if _, err := parseSourceAudioCommand(raw, time.UnixMilli(at)); err == nil {
			t.Fatal("invalid command time")
		}
		if _, err := parseSourceAudioQuery(audioControlFixtureBytes(t, "source-audio-query"), time.UnixMilli(at)); err == nil {
			t.Fatal("invalid query time")
		}
	}
}

func TestSourceAudioContractRejectsUnknownMissingNullAndWrongTypes(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	for _, kind := range []string{"source-audio", "source-audio-query"} {
		raw := audioControlFixtureBytes(t, kind)
		parse := func(raw []byte) error {
			if kind == "source-audio" {
				_, err := parseSourceAudioCommand(raw, now)
				return err
			}
			_, err := parseSourceAudioQuery(raw, now)
			return err
		}
		var base map[string]any
		_ = json.Unmarshal(raw, &base)
		for key := range base {
			for _, action := range []string{"missing", "null", "object"} {
				t.Run(kind+"/"+key+"/"+action, func(t *testing.T) {
					var value map[string]any
					_ = json.Unmarshal(raw, &value)
					if action == "missing" {
						delete(value, key)
					} else if action == "null" {
						value[key] = nil
					} else {
						value[key] = map[string]any{}
					}
					if parse(audioControlBytes(t, value)) == nil {
						t.Fatal("invalid top level accepted")
					}
				})
			}
		}
		for _, bad := range [][]byte{
			[]byte(strings.Replace(string(raw), `"version": 1`, `"version": 1, "ver\u0073ion": 1`, 1)),
			[]byte(strings.Replace(string(raw), `"version": 1`, `"version": 1, "authority": true`, 1)),
			append(append([]byte{}, raw...), []byte(` {}`)...), append([]byte{0xff}, raw...),
			[]byte(strings.Repeat(" ", maximumSourceAudioControlBytes+1)),
		} {
			if parse(bad) == nil {
				t.Fatal("invalid raw bytes accepted")
			}
		}
	}
}

func TestSourceAudioContractNestedAndSemanticRejection(t *testing.T) {
	raw := audioControlFixtureBytes(t, "source-audio")
	now := time.UnixMilli(1800000000000)
	for _, change := range []func(map[string]any){
		func(v map[string]any) { v["version"] = 2 }, func(v map[string]any) { v["type"] = "source-program-scene" },
		func(v map[string]any) { v["commandId"] = "scn_aaaaaaaaaaaaaaaa" },
		func(v map[string]any) { v["expectedAudioRevision"] = 9007199254740991 },
		func(v map[string]any) { v["expectedAudioRevision"] = 1.5 }, func(v map[string]any) { v["programEpoch"] = 0 },
		func(v map[string]any) { v["fencingRevision"] = 9007199254740992 },
		func(v map[string]any) { v["expiresAt"] = 1800000004001 },
		func(v map[string]any) { v["sources"] = []any{} },
		func(v map[string]any) { s := v["sources"].([]any)[0]; v["sources"] = []any{s, s} },
	} {
		var v map[string]any
		_ = json.Unmarshal(raw, &v)
		change(v)
		if _, err := parseSourceAudioCommand(audioControlBytes(t, v), now); err == nil {
			t.Fatal("invalid command accepted")
		}
	}
	for _, field := range []string{"sourceLeaseId", "leftGainQ15", "rightGainQ15", "muted"} {
		for _, bad := range []any{nil, map[string]any{}, -1, 32769, "false"} {
			var v map[string]any
			_ = json.Unmarshal(raw, &v)
			v["sources"].([]any)[0].(map[string]any)[field] = bad
			if _, err := parseSourceAudioCommand(audioControlBytes(t, v), now); err == nil {
				t.Fatal("invalid nested value accepted", field)
			}
		}
		var v map[string]any
		_ = json.Unmarshal(raw, &v)
		delete(v["sources"].([]any)[0].(map[string]any), field)
		if _, err := parseSourceAudioCommand(audioControlBytes(t, v), now); err == nil {
			t.Fatal("missing nested field accepted")
		}
	}
	for _, injected := range []string{`"muted": true, "gain": 0`, `"muted": true, "mut\u0065d": false`} {
		bad := strings.Replace(string(raw), `"muted": true`, injected, 1)
		if _, err := parseSourceAudioCommand([]byte(bad), now); err == nil {
			t.Fatal("nested extra/duplicate accepted")
		}
	}
}
