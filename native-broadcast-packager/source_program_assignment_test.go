package main

import (
	_ "embed"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

//go:embed testdata/source-program-assignment.v4.json
var sourceProgramAssignmentFixture []byte

func sourceProgramAssignmentTestClock() time.Time { return time.UnixMilli(1900000040000) }

func TestSourceProgramAssignmentStrictFieldSpellingAndDuplicates(t *testing.T) {
	raw := string(sourceProgramAssignmentFixture)
	for _, field := range []string{"version", "tenantId", "profileId", "width", "urls"} {
		t.Run("case-"+field, func(t *testing.T) {
			mutated := strings.Replace(raw, `"`+field+`":`, `"`+strings.ToUpper(field)+`":`, 1)
			if mutated == raw {
				t.Fatal("fixture mutation missing")
			}
			if _, err := parseSourceProgramAssignment([]byte(mutated), sourceProgramAssignmentTestClock()); err == nil {
				t.Fatal("case alias accepted")
			}
		})
	}
	for name, mutated := range map[string]string{
		"top":     strings.Replace(raw, `"version":`, `"version":3,"version":`, 1),
		"nested":  strings.Replace(raw, `"tenantId":`, `"tenantId":"tn_cccccccccccccccc","tenantId":`, 1),
		"escaped": strings.Replace(raw, `"tenantId":`, `"ten\u0061ntId":"tn_cccccccccccccccc","tenantId":`, 1),
	} {
		t.Run("duplicate-"+name, func(t *testing.T) {
			if _, err := parseSourceProgramAssignment([]byte(mutated), sourceProgramAssignmentTestClock()); err == nil {
				t.Fatal("duplicate field accepted")
			}
		})
	}
}

func TestSourceProgramAssignmentURIAndUnicodeBounds(t *testing.T) {
	for _, suffix := range []string{"\x00", "\t", "\n", "\r", "\v", "\f", "\u00a0", "\u2003", "\ufeff", "\u2028", "\u2029", "😀"} {
		var value sourceProgramAssignment
		if err := json.Unmarshal(sourceProgramAssignmentFixture, &value); err != nil {
			t.Fatal(err)
		}
		value.ICEServers[0].URLs[0] += suffix
		raw, _ := json.Marshal(value)
		if _, err := parseSourceProgramAssignment(raw, sourceProgramAssignmentTestClock()); err == nil {
			t.Fatalf("non-URI codepoint accepted: %U", []rune(suffix)[0])
		}
	}
	// Valid escaped spelling still names the exact canonical field once.
	escaped := strings.Replace(string(sourceProgramAssignmentFixture), `"tenantId":`, `"ten\u0061ntId":`, 1)
	if _, err := parseSourceProgramAssignment([]byte(escaped), sourceProgramAssignmentTestClock()); err != nil {
		t.Fatal(err)
	}
	invalidUTF8 := []byte(strings.Replace(string(sourceProgramAssignmentFixture), "synthetic-fixture-only", "\xff", 1))
	if _, err := parseSourceProgramAssignment(invalidUTF8, sourceProgramAssignmentTestClock()); err == nil {
		t.Fatal("invalid UTF8 accepted")
	}
}

func TestSourceProgramAssignmentScopeAndLegacyIsolation(t *testing.T) {
	now := sourceProgramAssignmentTestClock()
	a, err := parseSourceProgramAssignment(sourceProgramAssignmentFixture, now)
	if err != nil {
		t.Fatal(err)
	}
	direct := a
	direct.ICEServers = []assignmentICEServer{}
	rawDirect, _ := json.Marshal(direct)
	if _, err = parseSourceProgramAssignment(rawDirect, now); err != nil {
		t.Fatal("explicit direct ICE rejected", err)
	}
	direct.ICEServers = nil
	rawDirect, _ = json.Marshal(direct)
	if _, err = parseSourceProgramAssignment(rawDirect, now); err == nil {
		t.Fatal("null ICE array accepted")
	}
	s, err := a.scopeForDevice("dev_bbbbbbbbbbbbbbbb", now)
	if err != nil || s.tenantID != a.SourceContext.TenantID || s.roomEpoch != 4 || s.programEpoch != 2 || s.fencingRevision != 3 ||
		s.assignmentID != a.AssignmentID || s.writerLeaseID != a.LeaseID || s.roomID != a.RoomID || s.programID != a.ProgramID {
		t.Fatal("incomplete trusted program scope", err)
	}
	if _, err = a.scopeForDevice("dev_cccccccccccccccc", now); err == nil {
		t.Fatal("foreign grantee device accepted")
	}
	if _, err = a.scopeForDevice(s.deviceRef, time.UnixMilli(a.ExpiresAt)); err == nil {
		t.Fatal("expired scope projected")
	}
	// The legacy decoder never treats v4 as its single-publisher media path.
	if _, err = decodeServerMessage(sourceProgramAssignmentFixture); err == nil {
		t.Fatal("v4 silently fell through to legacy media")
	}
	legacy := assignmentMessage(now)
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = parseSourceProgramAssignment(raw, now); err == nil {
		t.Fatal("legacy publisher reinterpreted as trusted sources")
	}
}

func TestSourceProgramAssignmentRejectsAuthorityInjectionAndBounds(t *testing.T) {
	now := sourceProgramAssignmentTestClock()
	for _, change := range []func(map[string]any){
		func(v map[string]any) { v["publisherPeerId"] = "0123456789abcdef" },
		func(v map[string]any) { v["inputMode"] = "legacy" },
		func(v map[string]any) { v["version"] = 3 },
		func(v map[string]any) { delete(v, "sourceContext") },
		func(v map[string]any) { v["sourceContext"].(map[string]any)["key"] = "forbidden" },
		func(v map[string]any) { v["sourceContext"].(map[string]any)["tenantId"] = "unbound" },
		func(v map[string]any) { v["sourceContext"].(map[string]any)["roomEpoch"] = float64(9007199254740992) },
		func(v map[string]any) { v["sourceContext"].(map[string]any)["frameEnvelope"] = "unknown" },
		func(v map[string]any) { v["programEpoch"] = 0 },
		func(v map[string]any) { v["fencingRevision"] = float64(9007199254740992) },
		func(v map[string]any) { v["expiresAt"] = now.UnixMilli() },
		func(v map[string]any) { v["expiresAt"] = now.Add(121 * time.Second).UnixMilli() },
		func(v map[string]any) {
			p := v["profile"].(map[string]any)
			p["renditions"].([]any)[0].(map[string]any)["width"] = 321
		},
		func(v map[string]any) {
			p := v["profile"].(map[string]any)
			r := p["renditions"].([]any)
			p["renditions"] = append(r, r[0])
		},
		func(v map[string]any) { v["iceServers"].([]any)[0].(map[string]any)["username"] = "" },
		func(v map[string]any) {
			v["iceServers"].([]any)[1].(map[string]any)["urls"] = []string{"stun:stun.example.test:3478", "turn:turn.example.test:3478"}
		},
		func(v map[string]any) { v["iceServers"].([]any)[1].(map[string]any)["key"] = "forbidden" },
	} {
		var v map[string]any
		if json.Unmarshal(sourceProgramAssignmentFixture, &v) != nil {
			t.Fatal("fixture")
		}
		change(v)
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = parseSourceProgramAssignment(raw, now); err == nil {
			t.Fatal("invalid assignment accepted")
		}
	}
	for _, raw := range [][]byte{nil, []byte("null"), append(append([]byte(nil), sourceProgramAssignmentFixture...), []byte("{}")...), make([]byte, maximumSourceProgramAssignmentBytes+1)} {
		if _, err := parseSourceProgramAssignment(raw, now); err == nil {
			t.Fatal("invalid JSON/size accepted")
		}
	}
	// Remove every field at each required object level.
	for _, level := range []string{"", "sourceContext", "profile"} {
		var base map[string]json.RawMessage
		_ = json.Unmarshal(sourceProgramAssignmentFixture, &base)
		keys := base
		if level != "" {
			keys = make(map[string]json.RawMessage)
			_ = json.Unmarshal(base[level], &keys)
		}
		for key := range keys {
			var v map[string]any
			_ = json.Unmarshal(sourceProgramAssignmentFixture, &v)
			object := v
			if level != "" {
				object = v[level].(map[string]any)
			}
			delete(object, key)
			raw, _ := json.Marshal(v)
			if _, err := parseSourceProgramAssignment(raw, now); err == nil {
				t.Fatalf("missing required field %s/%s", level, key)
			}
		}
	}
}
