package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

func sourceControlBytes(t *testing.T, lease trustedsframe.SourceLease) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"version": 1, "type": "trusted-source-prepare", "lease": lease})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestTrustedSourceControlDispatchAndRenewWithoutCapture(t *testing.T) {
	c, lease, now := trustedSourceFixture(t)
	var statuses []map[string]any
	c.sendOverride = func(value any) error { statuses = append(statuses, value.(map[string]any)); return nil }
	dispatch := func(raw []byte, at time.Time) {
		t.Helper()
		message, err := decodeServerMessage(raw)
		if err != nil {
			t.Fatal(err)
		}
		if err = c.handleTrustedSourceControl(message.SourceControl, at); err != nil {
			t.Fatal(err)
		}
	}
	dispatch(sourceControlBytes(t, lease), now)
	receiver := c.trustedSources[lease.SourceLeaseID].receiver
	announcement, err := receiver.Announcement(now.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if statuses[0]["state"] != "receiver-prepared" || len(statuses[0]) != 10 || c.assignment.Media != nil || c.api != nil {
		t.Fatal("incorrect readiness or premature network/capture")
	}
	dispatch(sourceControlBytes(t, lease), now)
	lease.Revision++
	lease.IssuedAt += 1000
	lease.ExpiresAt += 1000
	dispatch(sourceControlBytes(t, lease), now.Add(time.Second))
	if c.trustedSources[lease.SourceLeaseID].receiver != receiver || statuses[2]["leaseRevision"] != int64(2) {
		t.Fatal("receiver replaced or wrong ACK")
	}
	unchanged, err := receiver.Announcement(now.Add(time.Second).UnixMilli())
	if err != nil || !bytes.Equal(announcement, unchanged) {
		t.Fatal("renew replaced agreement key", err)
	}
	stop := trustedsframe.SourceCommand{Version: 1, Type: "trusted-source-stop", SourceLeaseID: lease.SourceLeaseID, LeaseRevision: 2,
		ConsentID: lease.Consent.ConsentID, AssignmentID: lease.AssignmentID, FencingRevision: lease.FencingRevision, ExpiresAt: lease.ExpiresAt, ReasonCode: "SOURCE_REVOKED"}
	stopRaw, _ := json.Marshal(stop)
	dispatch(stopRaw, now.Add(time.Second))
	if statuses[3]["state"] != "stopped" || receiver.Alive(now.Add(time.Second).UnixMilli()) || len(c.trustedSources) != 0 {
		t.Fatal("stop retained receiver")
	}
	dispatch(stopRaw, now.Add(time.Second))
	if statuses[4]["state"] != "stopped" {
		t.Fatal("stop not idempotent")
	}
	lease.Revision = 1
	dispatch(sourceControlBytes(t, lease), now.Add(time.Second))
	if statuses[5]["state"] != "failed" || len(c.trustedSources) != 0 || c.assignment.State != "running" {
		t.Fatal("revoked consent revived or parent changed")
	}
}

func TestTrustedSourceControlExpiredAndDeniedAreSourceOnlyFailures(t *testing.T) {
	for _, revoke := range []func(*client){func(c *client) { c.rooms = nil }, func(c *client) { c.assignment.State = "draining" }, func(c *client) { c.assignment = nil }} {
		c, lease, now := trustedSourceFixture(t)
		revoke(c)
		var status map[string]any
		c.sendOverride = func(value any) error { status = value.(map[string]any); return nil }
		message, err := decodeServerMessage(sourceControlBytes(t, lease))
		if err != nil {
			t.Fatal(err)
		}
		if err = c.handleTrustedSourceControl(message.SourceControl, now); err != nil || status["state"] != "failed" {
			t.Fatal("source rejection disconnects control", err)
		}
	}
	c, lease, now := trustedSourceFixture(t)
	var status map[string]any
	c.sendOverride = func(value any) error { status = value.(map[string]any); return nil }
	message, err := decodeServerMessage(sourceControlBytes(t, lease))
	if err != nil {
		t.Fatal(err)
	}
	if err = c.handleTrustedSourceControl(message.SourceControl, now.Add(6*time.Second)); err != nil || status["state"] != "failed" {
		t.Fatal("expired source disconnects control", err)
	}
	if c.assignment.State != "running" || len(c.trustedSources) != 0 {
		t.Fatal("expiry disturbed parent or admitted source")
	}
	c.sessionAuthenticated.Store(false)
	if err = c.handleTrustedSourceControl(message.SourceControl, now); err == nil {
		t.Fatal("unauthenticated control admitted")
	}
}

func TestTrustedSourceControlRejectsMalformedClosedFields(t *testing.T) {
	_, lease, _ := trustedSourceFixture(t)
	raw := string(sourceControlBytes(t, lease))
	for _, invalid := range []string{
		strings.Replace(raw, `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(raw, `"consentId":`, `"ConsentId":`, 1),
		strings.Replace(raw, `"publicationId":`, `"privateKey":"forbidden","publicationId":`, 1),
		strings.Replace(raw, `"revision":1`, `"revision":null`, 1),
		raw + `{}`, raw[:len(raw)-1] + `,"key":"forbidden"}`,
		strings.Replace(raw, `"frameEnvelope":"codec-prefix-v1"`, `"frameEnvelope":"unknown"`, 1),
	} {
		if _, err := decodeServerMessage([]byte(invalid)); err == nil {
			t.Fatal("malformed source control accepted")
		}
	}
}

func TestTrustedSourceControlWrongStopScopeCannotCloseReceiver(t *testing.T) {
	c, lease, now := trustedSourceFixture(t)
	receiver, err := c.prepareTrustedSource(sourceBytes(t, lease), now)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*trustedsframe.SourceCommand){
		func(s *trustedsframe.SourceCommand) { s.ConsentID = "cns_bbbbbbbbbbbbbbbb" },
		func(s *trustedsframe.SourceCommand) { s.AssignmentID = "asn_bbbbbbbbbbbbbbbb" },
		func(s *trustedsframe.SourceCommand) { s.FencingRevision++ },
		func(s *trustedsframe.SourceCommand) { s.LeaseRevision += 2 },
	} {
		stop := &trustedsframe.SourceCommand{Version: 1, Type: "trusted-source-stop", SourceLeaseID: lease.SourceLeaseID, LeaseRevision: 1,
			ConsentID: lease.Consent.ConsentID, AssignmentID: lease.AssignmentID, FencingRevision: lease.FencingRevision, ExpiresAt: lease.ExpiresAt, ReasonCode: "SOURCE_REVOKED"}
		change(stop)
		if err = c.handleTrustedSourceControl(stop, now); err != nil {
			t.Fatal(err)
		}
		if !receiver.Alive(now.UnixMilli()) {
			t.Fatal("wrong stop closed receiver")
		}
	}
}

func trustedSourceFixture(t *testing.T) (*client, trustedsframe.SourceLease, time.Time) {
	t.Helper()
	now := time.Now()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	a := assignmentFrom(assignmentMessage(now))
	a.State = "running"
	c := &client{identity: identityFromKey(key), assignment: a, cfg: config{packagerID: "pkr_aaaaaaaaaaaaaaaa"}, rooms: []string{a.RoomID}, sendOverride: func(any) error { return nil }}
	c.sessionAuthenticated.Store(true)
	lease := trustedsframe.SourceLease{Version: 1, Type: "trusted-source-lease", SourceLeaseID: "sls_aaaaaaaaaaaaaaaa", Revision: 1,
		AssignmentID: a.AssignmentID, WriterLeaseID: a.LeaseID, FencingRevision: int64(a.FencingRevision), PublisherPeerID: "0123456789abcdef",
		PublisherDeviceRef: "dev_pppppppppppppppp", PublicationID: "track-source", PublicationEpoch: 2, Codec: "video/vp8", FrameEnvelope: trustedsframe.Envelope,
		IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(5 * time.Second).UnixMilli(),
		Consent: trustedsframe.Consent{Version: 1, Type: "trusted-decrypt-consent", Trigger: "user-action", ConsentID: "cns_aaaaaaaaaaaaaaaa", TenantID: "tn_aaaaaaaaaaaaaaaa",
			RoomID: a.RoomID, RoomEpoch: 3, ProgramID: a.ProgramID, ProgramEpoch: int64(a.ProgramEpoch), GrantorSubjectRef: "sub_pppppppppppppppp",
			GranteePackagerRef: c.cfg.packagerID, GranteeDeviceRef: c.trustedSourceDeviceRef(), SourceID: "src_aaaaaaaaaaaaaaaa", SourceKind: "camera", Purpose: "broadcast-program", Status: "active",
			GrantedAt: now.UnixMilli(), ExpiresAt: a.expiresAt.Load()}}
	t.Cleanup(c.closeTrustedSources)
	return c, lease, now
}
func sourceBytes(t *testing.T, lease trustedsframe.SourceLease) []byte {
	t.Helper()
	raw, err := json.Marshal(lease)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestTrustedSourceUsesActualLocalAuthority(t *testing.T) {
	for _, change := range []func(*client, *trustedsframe.SourceLease){
		func(c *client, l *trustedsframe.SourceLease) { c.sessionAuthenticated.Store(false) },
		func(c *client, l *trustedsframe.SourceLease) { c.rooms = nil }, func(c *client, l *trustedsframe.SourceLease) { c.assignment = nil },
		func(c *client, l *trustedsframe.SourceLease) { c.assignment.State = "ready" },
		func(c *client, l *trustedsframe.SourceLease) { l.Consent.GranteeDeviceRef = "dev_bbbbbbbbbbbbbbbb" },
		func(c *client, l *trustedsframe.SourceLease) { l.Consent.GranteePackagerRef = "pkr_bbbbbbbbbbbbbbbb" },
		func(c *client, l *trustedsframe.SourceLease) { l.FencingRevision++ }, func(c *client, l *trustedsframe.SourceLease) { l.Consent.ProgramEpoch++ },
		func(c *client, l *trustedsframe.SourceLease) { l.WriterLeaseID = "lea_bbbbbbbbbbbbbbbb" }, func(c *client, l *trustedsframe.SourceLease) { l.AssignmentID = "asn_bbbbbbbbbbbbbbbb" },
	} {
		c, l, now := trustedSourceFixture(t)
		change(c, &l)
		if _, err := c.prepareTrustedSource(sourceBytes(t, l), now); err == nil {
			t.Fatal("unauthorized source prepared")
		}
		if len(c.trustedSources) != 0 || len(c.trustedSourceHistory) != 0 {
			t.Fatal("invalid prepare consumed scope")
		}
	}
	c, l, now := trustedSourceFixture(t)
	s, err := c.prepareTrustedSource(sourceBytes(t, l), now)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Alive(now.UnixMilli()) {
		t.Fatal("source not alive")
	}
	other, err := c.prepareTrustedSource(sourceBytes(t, l), now)
	if err != nil || other != s {
		t.Fatal("prepare replaced receiver", err)
	}
	l.Revision++
	l.IssuedAt = now.Add(time.Second).UnixMilli()
	l.ExpiresAt = now.Add(6 * time.Second).UnixMilli()
	other, err = c.prepareTrustedSource(sourceBytes(t, l), now.Add(time.Second))
	if err != nil || other != s {
		t.Fatal("renew replaced receiver", err)
	}
	c.rooms = nil
	c.pruneTrustedSources(now.Add(time.Second))
	if s.Alive(now.Add(time.Second).UnixMilli()) || len(c.trustedSources) != 0 {
		t.Fatal("room revoke retained receiver")
	}
	c.rooms = []string{l.Consent.RoomID}
	l.Revision = 1
	l.SourceLeaseID = "sls_bbbbbbbbbbbbbbbb"
	if _, err = c.prepareTrustedSource(sourceBytes(t, l), now.Add(time.Second)); err == nil {
		t.Fatal("same consent recreated a receiver")
	}
}

func TestTrustedSourceParentStopClosesImmediately(t *testing.T) {
	for _, stop := range []func(*client, time.Time) error{
		func(c *client, now time.Time) error { c.closeAssignmentMedia(); return nil },
		func(c *client, now time.Time) error {
			return c.stopAssignment(serverMessage{AssignmentID: c.assignment.AssignmentID, ProgramEpoch: c.assignment.ProgramEpoch, FencingRevision: c.assignment.FencingRevision, ReasonCode: "USER_STOP"})
		},
		func(c *client, now time.Time) error { return c.reconcileLocalHealth("draining") },
		func(c *client, now time.Time) error {
			return c.transitionAssignment(c.assignment, "failed", "SOURCE_TEST")
		},
	} {
		c, l, now := trustedSourceFixture(t)
		s, err := c.prepareTrustedSource(sourceBytes(t, l), now)
		if err != nil {
			t.Fatal(err)
		}
		if err = stop(c, now); err != nil {
			t.Fatal(err)
		}
		if len(c.trustedSources) != 0 || s.Alive(now.UnixMilli()) {
			t.Fatal("parent stop retained receiver")
		}
	}
}
