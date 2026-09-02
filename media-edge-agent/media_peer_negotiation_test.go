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

func TestSubscriberLayerSwitchReusesNegotiatedSender(t *testing.T) {
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
	control := &fakeControl{messages: make(chan capturedControl, 8)}
	agent.setSignaling(control)
	const subscriberID = "fedcba9876543210"
	room := &mediaRoom{
		agent: agent, id: "room-123456", routeEpoch: 1,
		allowedPeers: map[string]bool{subscriberID: true}, peers: map[string]*mediaPeer{},
		subscriptions: map[string]subscriptionPlan{},
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	peer := &mediaPeer{room: room, id: subscriberID, pc: pc}
	room.peers[subscriberID] = peer
	t.Cleanup(peer.close)
	low, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000},
		"camera-track", "0123456789abcdef",
	)
	if err != nil {
		t.Fatal(err)
	}
	high, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000},
		"camera-track", "0123456789abcdef",
	)
	if err != nil {
		t.Fatal(err)
	}
	sender, err := pc.AddTrack(low)
	if err != nil {
		t.Fatal(err)
	}
	publication := &forwardPublication{
		room: room, publisherID: "0123456789abcdef", publicationID: "camera-track",
		layers: map[string]*forwardLayer{}, subscribers: map[string]*subscriberForward{},
	}
	publication.layers["low"] = &forwardLayer{publication: publication, name: "low", local: low}
	publication.layers["high"] = &forwardLayer{publication: publication, name: "high", local: high}
	output, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000},
		"camera-track", "0123456789abcdef",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.ReplaceTrack(output); err != nil {
		t.Fatal(err)
	}
	publication.subscribers[subscriberID] = &subscriberForward{
		layer: "low", revision: 1, sender: sender, local: output,
	}
	room.subscriptions[subscriptionKey(subscriberID, publication.publisherID, publication.publicationID)] = subscriptionPlan{
		SubscriberPeerID: subscriberID, PublisherPeerID: publication.publisherID,
		PublicationID: publication.publicationID, Source: "camera", Enabled: true,
		PreferredLayer: "high", MaximumLayer: "high", Revision: 2,
	}

	publication.reconcileSubscriber(subscriberID)
	forward := publication.subscribers[subscriberID]
	if forward == nil || forward.sender != sender || forward.layer != "high" || forward.revision != 2 {
		t.Fatal("subscriber layer switch replaced the sender or failed to apply the exact revision")
	}
	if sender.Track() != output {
		t.Fatal("subscriber layer switch replaced the continuous egress track")
	}
	if pc.SignalingState() != webrtc.SignalingStateStable {
		t.Fatal("same-codec layer switch unexpectedly required SDP renegotiation")
	}
}

func TestFederationForwardQueuesNegotiationDuringOutstandingOffer(t *testing.T) {
	cfg, err := loadConfig(environment(validEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	cfg.agentID = "edge-0000000000000001"
	api, closeTransport, err := createWebRTCAPI(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTransport()
	agent := newMediaAgent(cfg, api)
	control := &fakeControl{messages: make(chan capturedControl, 32)}
	agent.setSignaling(control)
	room := &mediaRoom{
		agent: agent, id: "room-123456", routeEpoch: 1, expiresAt: time.Now().Add(time.Minute),
		federationLinks: map[string]*federationPeer{}, tracks: map[string]*forwardPublication{},
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	peer := &federationPeer{
		room: room,
		link: federationLink{
			LinkID: "abcdefghijklmnopqrstuv", LeftAgentID: "edge-0000000000000001",
			RightAgentID: "edge-0000000000000002", InitiatorAgentID: "edge-0000000000000001",
		},
		remoteAgentID: "edge-0000000000000002", pc: pc, ready: true,
		senders: map[string]*federationForward{}, done: make(chan struct{}),
	}
	room.federationLinks[peer.link.LinkID] = peer
	t.Cleanup(func() { peer.close(false, "test-cleanup") })
	if _, err = pc.CreateDataChannel("federation-control", nil); err != nil {
		t.Fatal(err)
	}

	peer.negotiate()
	firstOffer := nextPeerOffer(t, control.messages)
	video, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000},
		"camera-track", "fed:0123456789abcdef:low",
	)
	if err != nil {
		t.Fatal(err)
	}
	publication := &forwardPublication{
		room: room, publisherID: "0123456789abcdef", publicationID: "camera-track",
		layers: map[string]*forwardLayer{}, subscribers: map[string]*subscriberForward{},
	}
	layer := &forwardLayer{
		publication: publication, name: "low", local: video, federationLocal: video,
		federationPeers: map[string]*federationPeer{},
	}
	publication.layers["low"] = layer
	transient, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000},
		"camera-track", "fed:0123456789abcdef:medium",
	)
	if err != nil {
		t.Fatal(err)
	}
	publication.layers["medium"] = &forwardLayer{
		publication: publication, name: "medium", local: transient, federationLocal: transient,
		federationPeers: map[string]*federationPeer{},
	}
	peer.setForward(publication, "medium", true)
	transientKey := federationTrackKey(publication.publisherID, publication.publicationID, "medium")
	if peer.senders[transientKey] == nil || peer.senders[transientKey].negotiated {
		t.Fatal("new federation sender was incorrectly considered negotiated")
	}
	peer.setForward(publication, "medium", false)
	if peer.senders[transientKey] != nil {
		t.Fatal("unnegotiated deselected sender was retained with an unadvertised media identity")
	}
	peer.setForward(publication, "low", true)
	if !waitForTestCondition(time.Second, func() bool {
		peer.mu.Lock()
		defer peer.mu.Unlock()
		return peer.needsNegotiation
	}) {
		t.Fatal("federation mutation was not queued behind the outstanding offer")
	}

	browser := newBrowserPeer(t, "fedcba9876543210")
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
	if err = peer.acceptSignal(serverMessage{Description: &answer}); err != nil {
		t.Fatal(err)
	}
	secondOffer := nextPeerOffer(t, control.messages)
	if !strings.Contains(secondOffer.SDP, "m=video") {
		t.Fatal("queued federation renegotiation did not advertise the added video track")
	}
	key := federationTrackKey(publication.publisherID, publication.publicationID, "low")
	forward := peer.senders[key]
	if forward == nil || !forward.active || forward.negotiated || forward.sender.Track() != video {
		t.Fatal("federation forward did not retain its active sender")
	}
	if err = browser.SetRemoteDescription(secondOffer); err != nil {
		t.Fatal(err)
	}
	secondAnswer, err := browser.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = browser.SetLocalDescription(secondAnswer); err != nil {
		t.Fatal(err)
	}
	if err = peer.acceptSignal(serverMessage{Description: &secondAnswer}); err != nil {
		t.Fatal(err)
	}
	if !forward.negotiated {
		t.Fatal("answered federation offer did not mark the advertised sender negotiated")
	}
	peer.setForward(publication, "low", false)
	if peer.senders[key] != forward || forward.active || forward.sender.Track() != nil {
		t.Fatal("federation deselection did not pause the retained sender")
	}
	peer.setForward(publication, "low", false)
	if peer.senders[key] != forward {
		t.Fatal("repeated federation deselection removed the reusable sender")
	}
	peer.setForward(publication, "low", true)
	if peer.senders[key] != forward || !forward.active || forward.sender.Track() != video {
		t.Fatal("federation reselection did not resume the retained sender")
	}
}
