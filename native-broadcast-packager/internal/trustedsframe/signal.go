package trustedsframe

import (
	"bytes"
	"encoding/json"
)

// SourcePeerSignal is metadata from the authenticated server, not permission to
// construct a PeerConnection. The adapter must still check its live SourceReceiver
// and exact publisher/assignment/fence before any network or key-channel action.
type SourcePeerSignal struct {
	Version             int                `json:"version"`
	Type                string             `json:"type"`
	SourceLeaseID       string             `json:"sourceLeaseId"`
	ConsentID           string             `json:"consentId"`
	AssignmentID        string             `json:"assignmentId"`
	FencingRevision     int64              `json:"fencingRevision"`
	PublisherPeerID     string             `json:"publisherPeerId"`
	NegotiationRevision int64              `json:"negotiationRevision"`
	Sequence            int64              `json:"sequence"`
	Description         *SourceDescription `json:"description,omitempty"`
	Candidate           json.RawMessage    `json:"candidate,omitempty"`
}
type SourceDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

func ParseSourcePeerSignal(raw []byte) (SourcePeerSignal, error) {
	var result SourcePeerSignal
	var fields map[string]json.RawMessage
	if len(raw) > 32768 || json.Unmarshal(raw, &fields) != nil {
		return result, ErrKey
	}
	_, description := fields["description"]
	_, candidate := fields["candidate"]
	if description == candidate {
		return result, ErrKey
	}
	keys := []string{"version", "type", "sourceLeaseId", "consentId", "assignmentId", "fencingRevision", "publisherPeerId", "negotiationRevision", "sequence"}
	if description {
		keys = append(keys, "description")
	} else {
		keys = append(keys, "candidate")
	}
	if exactObjectLimit(raw, keys, &result, 32768) != nil || result.Version != 1 || result.Type != "trusted-source-peer-signal" ||
		!ref(result.SourceLeaseID, "sls_") || !ref(result.ConsentID, "cns_") || !ref(result.AssignmentID, "asn_") ||
		!positive(result.FencingRevision) || !peerPattern.MatchString(result.PublisherPeerID) ||
		!positive(result.NegotiationRevision) || result.NegotiationRevision > 16 || !positive(result.Sequence) || result.Sequence > 129 {
		return result, ErrKey
	}
	if description {
		var value SourceDescription
		if exactObjectLimit(fields["description"], []string{"type", "sdp"}, &value, 32768) != nil || value.Type != "offer" || len(value.SDP) == 0 || len(value.SDP) > 16384 {
			return result, ErrKey
		}
		result.Description = &value
	} else if !sourceCandidate(fields["candidate"]) {
		return result, ErrKey
	}
	return result, nil
}

func sourceCandidate(raw []byte) bool {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return true
	}
	var fields map[string]json.RawMessage
	if len(raw) > 8192 || json.Unmarshal(raw, &fields) != nil {
		return false
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		switch key {
		case "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment":
		default:
			return false
		}
		keys = append(keys, key)
	}
	if exactObject(raw, keys, &fields) != nil {
		return false
	}
	var value string
	if bytes.Equal(bytes.TrimSpace(fields["candidate"]), []byte("null")) || json.Unmarshal(fields["candidate"], &value) != nil || len(value) > 4096 {
		return false
	}
	for _, key := range []string{"sdpMid", "usernameFragment"} {
		if value, found := fields[key]; found {
			var text *string
			if json.Unmarshal(value, &text) != nil || text != nil && len(*text) > 64 {
				return false
			}
		}
	}
	if value, found := fields["sdpMLineIndex"]; found {
		var index *int
		if json.Unmarshal(value, &index) != nil || index != nil && (*index < 0 || *index > 15) {
			return false
		}
	}
	return true
}
