package trustedsframe

import (
	"encoding/json"
	"regexp"
)

// SourceCommand contains no frame keys or media. Decode only verifies structure;
// the caller must check real time and current authenticated local parent policy.
type SourceCommand struct {
	Version         int             `json:"version"`
	Type            string          `json:"type"`
	Lease           json.RawMessage `json:"lease,omitempty"`
	SourceLeaseID   string          `json:"sourceLeaseId,omitempty"`
	LeaseRevision   int64           `json:"leaseRevision,omitempty"`
	ConsentID       string          `json:"consentId,omitempty"`
	AssignmentID    string          `json:"assignmentId,omitempty"`
	FencingRevision int64           `json:"fencingRevision,omitempty"`
	ExpiresAt       int64           `json:"expiresAt,omitempty"`
	ReasonCode      string          `json:"reasonCode,omitempty"`
}

var sourceReason = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)

func DecodeSourceCommand(raw []byte) (SourceCommand, error) {
	var c SourceCommand
	if len(raw) > 8192 || json.Unmarshal(raw, &c) != nil {
		return c, ErrKey
	}
	switch c.Type {
	case "trusted-source-prepare":
		if exactObject(raw, []string{"version", "type", "lease"}, &c) != nil || c.Version != 1 {
			return c, ErrKey
		}
		var claimed SourceLease
		if json.Unmarshal(c.Lease, &claimed) != nil {
			return c, ErrKey
		}
		// Structural validation at claimed issue time is NOT admission. A delayed
		// well-formed lease must reach the handler to return a source-only failure,
		// not disconnect the unrelated running program. prepare checks real time.
		if _, err := ParseSourceLease(c.Lease, claimed.IssuedAt); err != nil {
			return c, err
		}
	case "trusted-source-stop":
		if exactObject(raw, []string{"version", "type", "sourceLeaseId", "leaseRevision", "consentId", "assignmentId", "fencingRevision", "expiresAt", "reasonCode"}, &c) != nil ||
			c.Version != 1 || !ref(c.SourceLeaseID, "sls_") || !ref(c.ConsentID, "cns_") || !ref(c.AssignmentID, "asn_") ||
			!positive(c.LeaseRevision) || c.LeaseRevision > 1024 || !positive(c.FencingRevision) || !positive(c.ExpiresAt) || !sourceReason.MatchString(c.ReasonCode) {
			return c, ErrKey
		}
	default:
		return c, ErrKey
	}
	return c, nil
}
