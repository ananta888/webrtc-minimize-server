package main

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
	"github.com/pion/webrtc/v4"
)

func TestSourceAudioSocketDecoderOwnsBytesAndRemainsOptIn(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	for _, kind := range []string{"source-audio", "source-audio-query"} {
		raw := audioControlFixtureBytes(t, kind)
		if _, err := decodeServerMessage(raw); err == nil {
			t.Fatal("legacy decoder accepted audio control")
		}
		if _, err := decodePackagerControlMessage(raw, now, false); err == nil {
			t.Fatal("disabled control accepted")
		}
		borrowed := append([]byte{}, raw...)
		m, err := decodePackagerControlMessage(borrowed, now, true)
		clear(borrowed)
		if err != nil || !bytes.Equal(m.SourceAudio, raw) || len(m.SourceScene) != 0 {
			t.Fatal("audio bytes not isolated/owned", err)
		}
		if _, err := decodePackagerControlMessage(raw, now.Add(4*time.Second), true); err == nil {
			t.Fatal("expired decode accepted")
		}
	}
}

func audioSocketQuery(r sourceProgramAssignment) sourceAudioQuery {
	now := time.Now().UnixMilli()
	return sourceAudioQuery{sourceAudioControlScope: sourceAudioControlScope{Version: 1, Type: "source-program-audio-query",
		CommandID: "aud_aaaaaaaaaaaaaaaa", AssignmentID: r.AssignmentID, ProgramID: r.ProgramID, ProgramEpoch: r.ProgramEpoch, LeaseID: r.LeaseID, FencingRevision: r.FencingRevision},
		IssuedAt: now, ExpiresAt: now + 4000}
}

func TestSourceAudioSocketCurrentOwnerConflictAndRevocation(t *testing.T) {
	c, r, local, lease := sourceOwnerFixture(t)
	c.cfg.sourcePrograms = true
	var replies []any
	var mu sync.Mutex
	c.sendOverride = func(v any) error {
		mu.Lock()
		defer mu.Unlock()
		if m, ok := v.(map[string]any); ok && m["type"] == "assignment-status" {
			return nil
		}
		replies = append(replies, v)
		return nil
	}
	if err := c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, r), time.Now(), local, sourceOwnerTestFactory); err != nil {
		t.Fatal(err)
	}
	a := c.assignment
	handle := func(v any) error {
		m, err := decodePackagerControlMessage(audioControlBytes(t, v), time.Now(), true)
		if err != nil {
			return err
		}
		return c.handleSourceAudio(m)
	}
	q := audioSocketQuery(r)
	if err := handle(q); err != nil {
		t.Fatal(err)
	}
	state := replies[len(replies)-1].(sourceAudioReply)
	if state.Revision != 1 || len(state.Sources) != 0 {
		t.Fatal("initial audio state")
	}
	lease.Codec, lease.Consent.SourceKind = "audio/opus", "microphone"
	receiver, err := c.prepareTrustedSource(sourceBytes(t, lease), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// Receiver admission alone does not bind an audio input. The owner-level
	// test explicitly attaches it; the live socket case below uses real SDP.
	if _, err := a.sourceProgram.generation.Load().AddSource(lease, receiver); err != nil {
		t.Fatal(err)
	}
	if err := handle(q); err != nil {
		t.Fatal(err)
	}
	state = replies[len(replies)-1].(sourceAudioReply)
	if state.Revision != 2 || len(state.Sources) != 1 {
		t.Fatal("actual owned audio missing")
	}
	command := sourceAudioCommand{sourceAudioQuery: q, ExpectedAudioRevision: state.Revision, Sources: []sourceProgramAudioLevel{{lease.SourceLeaseID, 16384, 8192, true}}}
	command.Type = "source-program-audio"
	if err := handle(command); err != nil {
		t.Fatal(err)
	}
	if replies[len(replies)-1].(sourceAudioReceipt).AudioRevision != 3 {
		t.Fatal("application not acknowledged")
	}
	command.CommandID = "aud_bbbbbbbbbbbbbbbb"
	if err := handle(command); err != nil {
		t.Fatal("conflict broke control", err)
	}
	rejected := replies[len(replies)-1].(sourceAudioRejection)
	if rejected.ReasonCode != "AUDIO_NOT_APPLIED" || c.assignment != a || !a.sourceProgram.permitted() {
		t.Fatal("conflict changed owner")
	}
	if err := handle(q); err != nil {
		t.Fatal(err)
	}
	state = replies[len(replies)-1].(sourceAudioReply)
	if state.Revision != 3 || !state.Sources[0].Muted || state.Sources[0].Left != 16384 {
		t.Fatal("state after conflict changed")
	}
	count := len(replies)
	for _, change := range []func(*sourceAudioQuery){
		func(q *sourceAudioQuery) { q.AssignmentID = "asn_bbbbbbbbbbbbbbbb" }, func(q *sourceAudioQuery) { q.ProgramID = "prg_bbbbbbbbbbbbbbbb" },
		func(q *sourceAudioQuery) { q.ProgramEpoch++ }, func(q *sourceAudioQuery) { q.LeaseID = "lea_bbbbbbbbbbbbbbbb" }, func(q *sourceAudioQuery) { q.FencingRevision++ },
	} {
		bad := q
		change(&bad)
		if err := handle(bad); err == nil {
			t.Fatal("foreign query accepted")
		}
	}
	c.cfg.sourcePrograms = false
	if err := handle(q); err == nil {
		t.Fatal("local opt-in bypassed")
	}
	c.cfg.sourcePrograms = true
	c.sessionAuthenticated.Store(false)
	if err := handle(q); err == nil {
		t.Fatal("authentication bypassed")
	}
	c.sessionAuthenticated.Store(true)
	c.setConsentedRooms(nil)
	if err := handle(q); err == nil {
		t.Fatal("room consent bypassed")
	}
	if len(replies) != count {
		t.Fatal("unauthorized audio metadata returned")
	}
}

// Invoked after real TLS/P-256 authentication and actual HLS readiness. This
// proves control and source ownership, not audio decoding or audience samples.
func exerciseSourceAudioSocket(t *testing.T, r sourceProgramAssignment, base trustedsframe.SourceLease, write func(any), read func() map[string]any) {
	t.Helper()
	q := audioSocketQuery(r)
	write(q)
	initial := read()
	if initial["type"] != "source-program-audio-state" || initial["audioRevision"] != float64(1) || len(initial["sources"].([]any)) != 0 {
		t.Fatal("wire initial audio query")
	}
	lease := base
	lease.SourceLeaseID = "sls_bbbbbbbbbbbbbbbb"
	lease.Consent.ConsentID = "cns_bbbbbbbbbbbbbbbb"
	lease.Consent.SourceID = "src_bbbbbbbbbbbbbbbb"
	lease.PublicationID = "audio-fixture"
	lease.Codec, lease.Consent.SourceKind = "audio/opus", "microphone"
	lease.IssuedAt = time.Now().UnixMilli()
	lease.ExpiresAt = lease.IssuedAt + 5000
	write(map[string]any{"version": 1, "type": "trusted-source-prepare", "lease": lease})
	if read()["state"] != "receiver-prepared" {
		t.Fatal("wire audio source admission")
	}
	peer, err := nativeLoopbackAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	protocol := sourceKeyChannel
	if _, err = peer.CreateDataChannel(sourceKeyChannel, &webrtc.DataChannelInit{Protocol: &protocol}); err != nil {
		t.Fatal(err)
	}
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: "audio/opus", ClockRate: 48000, Channels: 2}, lease.PublicationID, "synthetic-audio-control")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = peer.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	// An actual bounded offer binds the lazy owner input. No RTP, frame key,
	// codec process or successful ICE/media delivery is claimed by this gate.
	write(sourcePeerMessage(lease, offer.SDP))
	q = audioSocketQuery(r)
	write(q)
	state := read()
	if state["audioRevision"] != float64(2) || len(state["sources"].([]any)) != 1 {
		t.Fatal("wire admitted audio missing")
	}
	command := sourceAudioCommand{sourceAudioQuery: q, ExpectedAudioRevision: 2, Sources: []sourceProgramAudioLevel{{lease.SourceLeaseID, 16384, 8192, true}}}
	command.Type = "source-program-audio"
	write(command)
	applied := read()
	if applied["type"] != "source-program-audio-applied" || applied["audioRevision"] != float64(3) {
		t.Fatal("wire audio not applied")
	}
	command.CommandID = "aud_bbbbbbbbbbbbbbbb"
	write(command)
	rejected := read()
	if rejected["type"] != "source-program-audio-rejected" || rejected["reasonCode"] != "AUDIO_NOT_APPLIED" {
		t.Fatal("wire CAS not rejected")
	}
	write(q)
	state = read()
	var decoded sourceAudioReply
	raw, _ := json.Marshal(state)
	if json.Unmarshal(raw, &decoded) != nil || decoded.Revision != 3 || len(decoded.Sources) != 1 || !decoded.Sources[0].Muted || decoded.Sources[0].Left != 16384 {
		t.Fatal("wire state after conflict")
	}
}
