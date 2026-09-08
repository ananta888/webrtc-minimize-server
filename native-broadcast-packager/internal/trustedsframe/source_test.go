package trustedsframe

import (
	"bytes"
	"encoding/json"
	"sync/atomic"
	"testing"
)

func sourceLeaseFixture() SourceLease {
	return SourceLease{Version: 1, Type: "trusted-source-lease", SourceLeaseID: "sls_aaaaaaaaaaaaaaaa", Revision: 1,
		Consent: consentFixture(), AssignmentID: "asn_aaaaaaaaaaaaaaaa", WriterLeaseID: "lea_aaaaaaaaaaaaaaaa", FencingRevision: 3,
		PublisherPeerID: "0123456789abcdef", PublisherDeviceRef: "dev_pppppppppppppppp", PublicationID: "track-camera", PublicationEpoch: 7,
		Codec: "video/vp8", FrameEnvelope: Envelope, IssuedAt: now, ExpiresAt: now + 5000}
}
func sourceFixture(t *testing.T, lease SourceLease, policy SourcePolicy) *SourceReceiver {
	t.Helper()
	s, err := NewSourceReceiver(jsonBytes(t, lease), lease.Consent.GranteePackagerRef, lease.Consent.GranteeDeviceRef, policy, now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Destroy)
	return s
}

func TestSourceLeaseClosedScope(t *testing.T) {
	lease := sourceLeaseFixture()
	raw := jsonBytes(t, lease)
	parsed, err := ParseSourceLease(raw, now)
	if err != nil || parsed != lease {
		t.Fatal("lease mismatch", err)
	}
	var fields map[string]any
	json.Unmarshal(raw, &fields)
	for key := range fields {
		bad := make(map[string]any)
		for k, v := range fields {
			bad[k] = v
		}
		delete(bad, key)
		if _, err := ParseSourceLease(jsonBytes(t, bad), now); err == nil {
			t.Fatal("missing field", key)
		}
		bad[key] = nil
		if _, err := ParseSourceLease(jsonBytes(t, bad), now); err == nil {
			t.Fatal("null field", key)
		}
	}
	for _, raw := range [][]byte{
		append(raw, []byte(" {}")...),
		bytes.Replace(raw, []byte(`"revision":1`), []byte(`"revision":1,"revision":1`), 1),
		bytes.Replace(raw, []byte(`"revision":1`), []byte(`"Revision":1`), 1),
		bytes.Replace(raw, []byte(`"trigger":"user-action"`), []byte(`"trigger":"user-action","trigger":"user-action"`), 1),
	} {
		if _, err := ParseSourceLease(raw, now); err == nil {
			t.Fatal("ambiguous lease JSON")
		}
	}
	for _, patch := range []map[string]any{{"codec": "video/h264"}, {"frameEnvelope": "unknown"}, {"expiresAt": now + 5001},
		{"expiresAt": now}, {"issuedAt": now + 1001}, {"revision": 1025}, {"publicationEpoch": maxSafeInteger + 1},
		{"publisherPeerId": "unknown"}, {"fencingRevision": 0}, {"publicationId": "bad track"}, {"key": "forbidden"}} {
		bad := make(map[string]any)
		for k, v := range fields {
			bad[k] = v
		}
		for k, v := range patch {
			bad[k] = v
		}
		if _, err := ParseSourceLease(jsonBytes(t, bad), now); err == nil {
			t.Fatal("invalid lease scope")
		}
	}
}

func TestSourceReceiverKeyACKRenewalAndReplay(t *testing.T) {
	lease := sourceLeaseFixture()
	s := sourceFixture(t, lease, func(SourceLease, int64) bool { return true })
	e := sealedFixture(t, s.receiver, now+60000)
	ack, err := s.AcceptKey(jsonBytes(t, e), now)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	json.Unmarshal(ack, &value)
	if len(value) != 10 || value["state"] != "key-installed" || value["sourceLeaseId"] != lease.SourceLeaseID ||
		value["envelopeId"] != e.EnvelopeID || value["keyId"] != e.KeyID || value["expiresAt"] != float64(lease.ExpiresAt) {
		t.Fatal("bad key ACK")
	}
	wire, plain := frame(t, s.receiver.decoder, 291, 400, true)
	decoded, err := s.Decrypt(wire, now)
	if err != nil || !bytes.Equal(decoded, plain) {
		t.Fatal("source frame", err)
	}
	before, _ := s.Announcement(now)
	next := lease
	next.Revision++
	next.IssuedAt = now + 1000
	next.ExpiresAt = now + 6000
	if err = s.Renew(jsonBytes(t, next), now+1000); err != nil {
		t.Fatal(err)
	}
	if err = s.Renew(jsonBytes(t, next), now+1000); err != nil {
		t.Fatal("idempotent renewal", err)
	}
	after, _ := s.Announcement(now + 1000)
	if !bytes.Equal(before, after) {
		t.Fatal("renewal replaced agreement key")
	}
	if _, err = s.Decrypt(wire, now+1000); err != ErrReplay {
		t.Fatal("renewal reset frame replay", err)
	}
	if _, err = s.AcceptKey(jsonBytes(t, e), now+1000); err != ErrReplay {
		t.Fatal("renewal reset key replay", err)
	}
	if s.Alive(next.ExpiresAt) || s.Alive(next.ExpiresAt-1) {
		t.Fatal("expired source revived")
	}
}

func TestSourceRenewalCannotExtendAuthority(t *testing.T) {
	lease := sourceLeaseFixture()
	for _, change := range []func(*SourceLease){
		func(l *SourceLease) { l.AssignmentID = "asn_bbbbbbbbbbbbbbbb" }, func(l *SourceLease) { l.WriterLeaseID = "lea_bbbbbbbbbbbbbbbb" },
		func(l *SourceLease) { l.FencingRevision++ }, func(l *SourceLease) { l.PublicationEpoch++ }, func(l *SourceLease) { l.PublisherPeerID = "fedcba9876543210" },
		func(l *SourceLease) { l.Consent.RoomEpoch++ }, func(l *SourceLease) { l.Consent.ProgramEpoch++ }, func(l *SourceLease) { l.Consent.GranteeDeviceRef = "dev_bbbbbbbbbbbbbbbb" },
		func(l *SourceLease) { l.SourceLeaseID = "sls_bbbbbbbbbbbbbbbb" }, func(l *SourceLease) { l.Revision++ }, func(l *SourceLease) { l.ExpiresAt = now + 5000 },
	} {
		s := sourceFixture(t, lease, func(SourceLease, int64) bool { return true })
		next := lease
		next.Revision++
		next.IssuedAt = now + 1000
		next.ExpiresAt = now + 6000
		change(&next)
		if err := s.Renew(jsonBytes(t, next), now+1000); err == nil {
			t.Fatal("expanded renewal accepted")
		}
		if !s.Alive(now+1000) || s.lease != lease {
			t.Fatal("invalid renewal changed live lease")
		}
	}
	for _, policy := range []SourcePolicy{nil, func(SourceLease, int64) bool { return false }} {
		if _, err := NewSourceReceiver(jsonBytes(t, lease), lease.Consent.GranteePackagerRef, lease.Consent.GranteeDeviceRef, policy, now); err == nil {
			t.Fatal("no parent authority")
		}
	}
	var permitted atomic.Bool
	permitted.Store(true)
	s := sourceFixture(t, lease, func(SourceLease, int64) bool { return permitted.Load() })
	permitted.Store(false)
	if s.Alive(now) {
		t.Fatal("parent revoke")
	}
	permitted.Store(true)
	if s.Alive(now) {
		t.Fatal("revoked parent revived")
	}
}

func TestSourceActiveTimerAndObsoleteCallback(t *testing.T) {
	lease := sourceLeaseFixture()
	lease.ExpiresAt = now + 30
	s := sourceFixture(t, lease, func(SourceLease, int64) bool { return true })
	key := sealedFixture(t, s.receiver, now+60000)
	if _, err := s.AcceptKey(jsonBytes(t, key), now); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.closed && s.timer == nil && s.receiver.private == nil
	})
	if s.Alive(now) {
		t.Fatal("timer-expired source revived")
	}
	other := sourceFixture(t, sourceLeaseFixture(), func(SourceLease, int64) bool { return true })
	other.expire() // Simulates an old callback already runnable when a lease was renewed.
	if !other.Alive(now) {
		t.Fatal("obsolete timer closed current lease")
	}
	var zero SourceReceiver
	if zero.Alive(now) {
		t.Fatal("zero source accepted")
	}
	zero.Destroy()
}

func TestSourceDropsPlaintextWhenParentRevokesDuringDecrypt(t *testing.T) {
	checking, calls := false, 0
	s := sourceFixture(t, sourceLeaseFixture(), func(SourceLease, int64) bool {
		if !checking {
			return true
		}
		calls++
		return calls < 3
	})
	e := sealedFixture(t, s.receiver, now+60000)
	if _, err := s.AcceptKey(jsonBytes(t, e), now); err != nil {
		t.Fatal(err)
	}
	wire, _ := frame(t, s.receiver.decoder, 291, 400, true)
	checking = true
	plain, err := s.Decrypt(wire, now)
	if err != ErrClosed || plain != nil || s.Alive(now) {
		t.Fatal("revoked plaintext escaped", err)
	}
}

func FuzzSourceLease(f *testing.F) {
	f.Add(jsonBytes(f, sourceLeaseFixture()))
	f.Fuzz(func(t *testing.T, raw []byte) {
		lease, err := ParseSourceLease(raw, now)
		if err == nil && (lease.ExpiresAt <= now || lease.ExpiresAt > now+5000 || lease.FrameEnvelope != Envelope) {
			t.Fatal("invalid successful lease")
		}
	})
}
