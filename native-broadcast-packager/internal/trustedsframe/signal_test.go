package trustedsframe

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func sourceSignalFixture() SourcePeerSignal {
	return SourcePeerSignal{Version: 1, Type: "trusted-source-peer-signal", SourceLeaseID: "sls_aaaaaaaaaaaaaaaa",
		ConsentID: "cns_aaaaaaaaaaaaaaaa", AssignmentID: "asn_aaaaaaaaaaaaaaaa", FencingRevision: 1,
		PublisherPeerID: "0123456789abcdef", NegotiationRevision: 1, Sequence: 1,
		Description: &SourceDescription{Type: "offer", SDP: "v=0\r\n"}}
}

func TestSourcePeerSignalClosedScope(t *testing.T) {
	value := sourceSignalFixture()
	for _, candidate := range []json.RawMessage{nil, json.RawMessage(`null`), json.RawMessage(`{"candidate":"","sdpMid":null,"sdpMLineIndex":null,"usernameFragment":"test"}`)} {
		if candidate != nil {
			value.Description = nil
			value.Candidate = candidate
			value.Sequence = 2
		}
		raw := jsonBytes(t, value)
		if _, err := ParseSourcePeerSignal(raw); err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		json.Unmarshal(raw, &fields)
		for key, before := range fields {
			delete(fields, key)
			if _, err := ParseSourcePeerSignal(jsonBytes(t, fields)); err == nil {
				t.Fatal("missing field", key)
			}
			fields[key] = before
		}
		for _, bad := range [][]byte{
			append(append([]byte(nil), raw...), []byte(`{}`)...),
			bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1),
			bytes.Replace(raw, []byte(`"version":1`), []byte(`"Version":1`), 1),
			bytes.Replace(raw, []byte(`"version":1`), []byte(`"version":1,"keys":[]`), 1),
			append(bytes.Repeat([]byte(" "), 32768), raw...),
		} {
			if _, err := ParseSourcePeerSignal(bad); err == nil {
				t.Fatal("ambiguous signal")
			}
		}
	}
}

func TestSourcePeerSignalNestedByteAndDirectionBounds(t *testing.T) {
	for _, sdp := range []string{"", strings.Repeat("ä", 8193)} {
		value := sourceSignalFixture()
		value.Description.SDP = sdp
		if _, err := ParseSourcePeerSignal(jsonBytes(t, value)); err == nil {
			t.Fatal("unbounded SDP")
		}
	}
	value := sourceSignalFixture()
	value.Description.Type = "answer"
	if _, err := ParseSourcePeerSignal(jsonBytes(t, value)); err == nil {
		t.Fatal("wrong role")
	}
	value.Description = nil
	value.Sequence = 2
	for _, raw := range []string{`{"candidate":null}`, `{"candidate":"","candidate":""}`, `{"candidate":"","privateKey":"forbidden"}`,
		`{"candidate":"","sdpMLineIndex":16}`, `{"candidate":"","sdpMid":false}`, `{"candidate":"` + strings.Repeat("ä", 2049) + `"}`} {
		value.Candidate = json.RawMessage(raw)
		if _, err := ParseSourcePeerSignal(jsonBytes(t, value)); err == nil {
			t.Fatal("invalid candidate")
		}
	}
}

func FuzzSourcePeerSignal(f *testing.F) {
	raw, _ := json.Marshal(sourceSignalFixture())
	f.Add(raw)
	f.Fuzz(func(t *testing.T, raw []byte) {
		value, err := ParseSourcePeerSignal(raw)
		if err != nil {
			return
		}
		if len(raw) > 32768 || value.Version != 1 || value.Sequence < 1 || value.Sequence > 129 {
			t.Fatal("unbounded source signal")
		}
		canonical, _ := json.Marshal(value)
		if _, err := ParseSourcePeerSignal(canonical); err != nil {
			t.Fatal("unstable decoded signal", err)
		}
	})
}
