package trustedsframe

import (
	"bytes"
	"encoding/json"
	"testing"
)

func sourceCommands() []SourceCommand {
	lease := sourceLeaseFixture()
	raw, _ := json.Marshal(lease)
	return []SourceCommand{{Version: 1, Type: "trusted-source-prepare", Lease: raw},
		{Version: 1, Type: "trusted-source-stop", SourceLeaseID: lease.SourceLeaseID, LeaseRevision: 1,
			ConsentID: lease.Consent.ConsentID, AssignmentID: lease.AssignmentID, FencingRevision: lease.FencingRevision,
			ExpiresAt: lease.ExpiresAt, ReasonCode: "SOURCE_REVOKED"}}
}

func TestSourceControlClosedFields(t *testing.T) {
	for _, command := range sourceCommands() {
		raw := jsonBytes(t, command)
		if _, err := DecodeSourceCommand(raw); err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		json.Unmarshal(raw, &fields)
		for key, value := range fields {
			delete(fields, key)
			if _, err := DecodeSourceCommand(jsonBytes(t, fields)); err == nil {
				t.Fatal("missing field", key)
			}
			fields[key] = json.RawMessage(`null`)
			if _, err := DecodeSourceCommand(jsonBytes(t, fields)); err == nil {
				t.Fatal("null field", key)
			}
			fields[key] = value
		}
		for _, bad := range [][]byte{
			append(append([]byte(nil), raw...), []byte(`{}`)...),
			bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1),
			bytes.Replace(raw, []byte(`"version":1`), []byte(`"Version":1`), 1),
			bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"keys":[]`), 1),
			append(bytes.Repeat([]byte(" "), 8192), raw...),
		} {
			if _, err := DecodeSourceCommand(bad); err == nil {
				t.Fatal("ambiguous, extra or oversized control")
			}
		}
	}
}

func FuzzSourceControl(f *testing.F) {
	for _, command := range sourceCommands() {
		raw, _ := json.Marshal(command)
		f.Add(raw)
	}
	f.Add([]byte(`{"version":1,"type":"trusted-source-prepare","lease":null}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		command, err := DecodeSourceCommand(raw)
		if err != nil {
			return
		}
		if len(raw) > 8192 || command.Version != 1 {
			t.Fatal("unbounded control")
		}
		canonical, err := json.Marshal(command)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = DecodeSourceCommand(canonical); err != nil {
			t.Fatal("unstable decoded control", err)
		}
	})
}
