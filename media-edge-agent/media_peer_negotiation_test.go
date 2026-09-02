package main

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func nextPeerOffer(t *testing.T, messages <-chan capturedControl) webrtc.SessionDescription {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case message := <-messages:
			if message.Description != nil && message.Description.Type == webrtc.SDPTypeOffer {
				return *message.Description
			}
		case <-timer.C:
			t.Fatal("timed out waiting for native peer offer")
		}
	}
}

func TestMediaPeerRetriesNegotiationRequestedDuringOutstandingOffer(t *testing.T) {
	cfg, err := loadConfig(environment(validEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	api, closeTransport, err := createWebRTCAPI(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTransport()
	agent := newMediaAgent(cfg, api)
	control := &fakeControl{messages: make(chan capturedControl, 32)}
	agent.setSignaling(control)
	room := &mediaRoom{agent: agent, id: "room-123456", routeEpoch: 1}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	peer := &mediaPeer{room: room, id: "0123456789abcdef", pc: pc}
	t.Cleanup(peer.close)
	if _, err = pc.CreateDataChannel("bootstrap", nil); err != nil {
		t.Fatal(err)
	}

	peer.negotiate()
	firstOffer := nextPeerOffer(t, control.messages)
	if strings.Contains(firstOffer.SDP, "m=video") {
		t.Fatal("initial bootstrap offer unexpectedly contained video")
	}
	video, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000},
		"camera-track", "publisher-stream",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pc.AddTrack(video); err != nil {
		t.Fatal(err)
	}
	// This request arrives while the bootstrap offer is still outstanding. It
	// must be coalesced and retried after the answer instead of being dropped.
	peer.negotiate()

	browser := newBrowserPeer(t, peer.id)
	if err = browser.SetRemoteDescription(firstOffer); err != nil {
		t.Fatal(err)
	}
	answer, err := browser.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = browser.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	if err = peer.acceptSignal(serverMessage{
		Type: "peer-signal", RoomID: room.id, PeerID: peer.id, RouteEpoch: room.routeEpoch,
		Description: &answer,
	}); err != nil {
		t.Fatal(err)
	}

	secondOffer := nextPeerOffer(t, control.messages)
	if !strings.Contains(secondOffer.SDP, "m=video") {
		t.Fatal("coalesced renegotiation did not advertise the added video track")
	}
}
