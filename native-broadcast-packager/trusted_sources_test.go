package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

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
