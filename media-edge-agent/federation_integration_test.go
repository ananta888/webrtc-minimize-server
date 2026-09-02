package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type routedAgentMessage struct {
	fromAgentID string
	raw         []byte
}

type routedAgentControl struct {
	agentID string
	output  chan<- routedAgentMessage
}

func (r *routedAgentControl) send(value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	select {
	case r.output <- routedAgentMessage{fromAgentID: r.agentID, raw: raw}:
		return nil
	case <-time.After(time.Second):
		return fmt.Errorf("agent broker queue full")
	}
}

type federationBrowserEndpoint struct {
	mu         sync.Mutex
	pc         *webrtc.PeerConnection
	agent      *mediaAgent
	roomID     string
	peerID     string
	routeEpoch int64
	pendingICE []webrtc.ICECandidateInit
}

type routedAgentOutput struct {
	Type             string                     `json:"type"`
	RecipientAgentID string                     `json:"recipientAgentId"`
	RoomID           string                     `json:"roomId"`
	PeerID           string                     `json:"peerId"`
	RouteEpoch       int64                      `json:"routeEpoch"`
	LinkID           string                     `json:"linkId"`
	Description      *webrtc.SessionDescription `json:"description"`
	Candidate        json.RawMessage            `json:"candidate"`
}

func runAgentMessageBroker(
	stop <-chan struct{},
	output <-chan routedAgentMessage,
	agents map[string]*mediaAgent,
	browsers map[string]*federationBrowserEndpoint,
	errors chan<- error,
) {
	report := func(err error) {
		select {
		case errors <- err:
		default:
		}
	}
	for {
		select {
		case <-stop:
			return
		case routed := <-output:
			var message routedAgentOutput
			if err := json.Unmarshal(routed.raw, &message); err != nil {
				report(err)
				continue
			}
			switch message.Type {
			case "federation-signal":
				recipient := agents[message.RecipientAgentID]
				if recipient == nil {
					report(fmt.Errorf("unknown federation recipient %q", message.RecipientAgentID))
					continue
				}
				if err := recipient.handleFederationSignal(serverMessage{
					Type: "federation-peer-signal", RoomID: message.RoomID,
					RouteEpoch: message.RouteEpoch, LinkID: message.LinkID,
					FromAgentID: routed.fromAgentID, Description: message.Description,
					Candidate: message.Candidate,
				}); err != nil {
					report(err)
				}
			case "media-agent-signal":
				browser := browsers[message.PeerID]
				if browser == nil {
					report(fmt.Errorf("unknown browser recipient %q", message.PeerID))
					continue
				}
				if err := applyAgentSignalToBrowser(browser, message); err != nil {
					report(err)
				}
			}
		}
	}
}

func applyAgentSignalToBrowser(browser *federationBrowserEndpoint, message routedAgentOutput) error {
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if message.Description != nil {
		if err := browser.pc.SetRemoteDescription(*message.Description); err != nil {
			return fmt.Errorf("set browser remote description: %w", err)
		}
		for _, candidate := range browser.pendingICE {
			if err := browser.pc.AddICECandidate(candidate); err != nil {
				return fmt.Errorf("apply queued browser ICE: %w", err)
			}
		}
		browser.pendingICE = nil
		if message.Description.Type != webrtc.SDPTypeOffer {
			return nil
		}
		answer, err := browser.pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		gathered := webrtc.GatheringCompletePromise(browser.pc)
		if err = browser.pc.SetLocalDescription(answer); err != nil {
			return err
		}
		select {
		case <-gathered:
		case <-time.After(5 * time.Second):
			return fmt.Errorf("browser answer ICE gathering timeout")
		}
		local := *browser.pc.LocalDescription()
		return browser.agent.handleSignal(serverMessage{
			Type: "peer-signal", RoomID: browser.roomID, PeerID: browser.peerID,
			RouteEpoch: browser.routeEpoch, Description: &local,
		})
	}
	if len(message.Candidate) == 0 || bytes.Equal(bytes.TrimSpace(message.Candidate), []byte("null")) {
		return nil
	}
	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal(message.Candidate, &candidate); err != nil {
		return err
	}
	if browser.pc.RemoteDescription() == nil {
		browser.pendingICE = append(browser.pendingICE, candidate)
		return nil
	}
	return browser.pc.AddICECandidate(candidate)
}

func waitForTestCondition(timeout time.Duration, condition func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return condition()
}

func federationPeerReady(agent *mediaAgent, roomID, linkID string) bool {
	agent.mu.RLock()
	room := agent.rooms[roomID]
	agent.mu.RUnlock()
	if room == nil {
		return false
	}
	room.mu.RLock()
	peer := room.federationLinks[linkID]
	room.mu.RUnlock()
	if peer == nil {
		return false
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return peer.ready && !peer.closed
}

func TestNativeAgentsFederateBidirectionalDemandedOpaqueLayersWithoutOfferGlare(t *testing.T) {
	valuesA := validEnvironment()
	valuesA["MEDIA_AGENT_ID"] = "agent-a"
	cfgA, err := loadConfig(environment(valuesA))
	if err != nil {
		t.Fatal(err)
	}
	valuesB := validEnvironment()
	valuesB["MEDIA_AGENT_ID"] = "agent-b"
	cfgB, err := loadConfig(environment(valuesB))
	if err != nil {
		t.Fatal(err)
	}
	apiA, closeA, err := createWebRTCAPI(cfgA)
	if err != nil {
		t.Fatal(err)
	}
	defer closeA()
	apiB, closeB, err := createWebRTCAPI(cfgB)
	if err != nil {
		t.Fatal(err)
	}
	defer closeB()
	agentA := newMediaAgent(cfgA, apiA)
	agentB := newMediaAgent(cfgB, apiB)
	defer agentA.close()
	defer agentB.close()
	output := make(chan routedAgentMessage, 2048)
	agentA.setSignaling(&routedAgentControl{agentID: cfgA.agentID, output: output})
	agentB.setSignaling(&routedAgentControl{agentID: cfgB.agentID, output: output})

	const (
		roomID       = "room-123456"
		publisherID  = "0123456789abcdef"
		subscriberID = "fedcba9876543210"
		linkID       = "abcdefghijklmnopqrstuv"
	)
	cameraRoute := federationRoute{
		PublisherPeerID: publisherID, SourceAgentID: cfgA.agentID, MaximumHops: 2,
		Edges: []federationEdge{{
			LinkID: linkID, FromAgentID: cfgA.agentID, ToAgentID: cfgB.agentID,
		}},
	}
	link := federationLink{
		LinkID: linkID, LeftAgentID: cfgA.agentID, RightAgentID: cfgB.agentID,
		InitiatorAgentID: cfgA.agentID,
	}
	cameraDemand := federationDemand{
		LinkID: linkID, FromAgentID: cfgA.agentID, ToAgentID: cfgB.agentID,
		PublisherPeerID: publisherID, PublicationID: "camera-track", Layer: "medium",
	}
	audioRoute := federationRoute{
		PublisherPeerID: subscriberID, SourceAgentID: cfgB.agentID, MaximumHops: 2,
		Edges: []federationEdge{{
			LinkID: linkID, FromAgentID: cfgB.agentID, ToAgentID: cfgA.agentID,
		}},
	}
	audioDemand := federationDemand{
		LinkID: linkID, FromAgentID: cfgB.agentID, ToAgentID: cfgA.agentID,
		PublisherPeerID: subscriberID, PublicationID: "microphone-track", Layer: "audio",
	}
	now := time.Now()
	expiresAt := now.Add(45 * time.Second).UnixMilli()
	leaseA := agentLease{
		Version: 3, Type: "agent-lease", RoomID: roomID, Role: "primary",
		MembershipEpoch: 1, RouteEpoch: 1, LeaseExpiresAt: expiresAt,
		Peers: []leasePeer{
			{ID: publisherID, Connect: true, Publish: true, Subscribe: true},
			{ID: subscriberID},
		},
		Subscriptions: []subscriptionPlan{{
			SubscriberPeerID: publisherID, PublisherPeerID: subscriberID,
			PublicationID: "microphone-track", Source: "microphone", Enabled: true,
			PreferredLayer: "audio", MaximumLayer: "audio", Revision: 1,
		}}, FederationLinks: []federationLink{link},
		FederationRoutes:  []federationRoute{cameraRoute, audioRoute},
		FederationDemands: []federationDemand{cameraDemand, audioDemand},
		ICEServers:        []webrtc.ICEServer{},
	}
	leaseB := agentLease{
		Version: 3, Type: "agent-lease", RoomID: roomID, Role: "standby",
		MembershipEpoch: 1, RouteEpoch: 1, LeaseExpiresAt: expiresAt,
		Peers: []leasePeer{
			{ID: publisherID},
			{ID: subscriberID, Connect: true, Publish: true, Subscribe: true},
		},
		Subscriptions: []subscriptionPlan{{
			SubscriberPeerID: subscriberID, PublisherPeerID: publisherID,
			PublicationID: "camera-track", Source: "camera", Enabled: true,
			PreferredLayer: "high", MaximumLayer: "high", Revision: 1,
		}},
		FederationLinks:   []federationLink{link},
		FederationRoutes:  []federationRoute{cameraRoute, audioRoute},
		FederationDemands: []federationDemand{cameraDemand, audioDemand}, ICEServers: []webrtc.ICEServer{},
	}

	publisher := newBrowserPeer(t, publisherID)
	subscriber := newBrowserPeer(t, subscriberID)
	lowTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"camera-track", "publisher-stream", webrtc.WithRTPStreamID("q"),
	)
	if err != nil {
		t.Fatal(err)
	}
	mediumTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"camera-track", "publisher-stream", webrtc.WithRTPStreamID("h"),
	)
	if err != nil {
		t.Fatal(err)
	}
	highTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"camera-track", "publisher-stream", webrtc.WithRTPStreamID("f"),
	)
	if err != nil {
		t.Fatal(err)
	}
	sender, err := publisher.AddTrack(lowTrack)
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.AddEncoding(mediumTrack); err != nil {
		t.Fatal(err)
	}
	if err = sender.AddEncoding(highTrack); err != nil {
		t.Fatal(err)
	}
	audioTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
		},
		"microphone-track", "subscriber-stream",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = subscriber.AddTrack(audioTrack); err != nil {
		t.Fatal(err)
	}
	receivedCamera := make(chan *webrtc.TrackRemote, 1)
	receivedAudio := make(chan *webrtc.TrackRemote, 1)
	subscriber.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { receivedCamera <- track })
	publisher.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { receivedAudio <- track })
	browsers := map[string]*federationBrowserEndpoint{
		publisherID: {
			pc: publisher, agent: agentA, roomID: roomID, peerID: publisherID, routeEpoch: 1,
		},
		subscriberID: {
			pc: subscriber, agent: agentB, roomID: roomID, peerID: subscriberID, routeEpoch: 1,
		},
	}
	brokerStop := make(chan struct{})
	brokerErrors := make(chan error, 16)
	defer close(brokerStop)
	go runAgentMessageBroker(
		brokerStop,
		output,
		map[string]*mediaAgent{cfgA.agentID: agentA, cfgB.agentID: agentB},
		browsers,
		brokerErrors,
	)

	// The non-initiator receives its server-authored lease first. The agents
	// then establish one direct, authenticated control/media PeerConnection.
	if err = agentB.applySync([]agentLease{leaseB}, now); err != nil {
		t.Fatal(err)
	}
	if err = agentA.applySync([]agentLease{leaseA}, now); err != nil {
		t.Fatal(err)
	}
	if !waitForTestCondition(10*time.Second, func() bool {
		return federationPeerReady(agentA, roomID, linkID) && federationPeerReady(agentB, roomID, linkID)
	}) {
		select {
		case brokerErr := <-brokerErrors:
			t.Fatalf("federation failed: %v", brokerErr)
		default:
			t.Fatal("direct agent-agent federation did not become ready")
		}
	}

	for peerID, browser := range browsers {
		description := gatheredLocalDescription(t, browser.pc)
		if err = browser.agent.handleSignal(serverMessage{
			Type: "peer-signal", RoomID: roomID, PeerID: peerID, RouteEpoch: 1,
			Description: &description,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if !waitForTestCondition(10*time.Second, func() bool {
		return publisher.RemoteDescription() != nil && subscriber.RemoteDescription() != nil
	}) {
		t.Fatal("browser-agent connections did not negotiate")
	}

	parameters := sender.GetParameters()
	var midExtensionID, ridExtensionID uint8
	for _, extension := range parameters.HeaderExtensions {
		switch extension.URI {
		case "urn:ietf:params:rtp-hdrext:sdes:mid":
			midExtensionID = uint8(extension.ID)
		case "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id":
			ridExtensionID = uint8(extension.ID)
		}
	}
	if midExtensionID == 0 || ridExtensionID == 0 || len(publisher.GetTransceivers()) == 0 {
		t.Fatal("simulcast MID/RID extensions were not negotiated")
	}
	mid := publisher.GetTransceivers()[0].Mid()
	lowCiphertext := []byte{0x88, 0x08, 0x6c, 0x6f, 0x77, 0xde, 0xad, 0xbe, 0xef}
	mediumCiphertext := []byte{0x88, 0x08, 0x6d, 0x69, 0x64, 0xde, 0xad, 0xbe, 0xef}
	highCiphertext := []byte{0x88, 0x08, 0x68, 0x69, 0x67, 0x68, 0xde, 0xad, 0xbe, 0xef}
	audioCiphertext := []byte{0xf8, 0xff, 0xfe, 0x11, 0x22, 0x33}
	writerStop := make(chan struct{})
	defer close(writerStop)
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-writerStop:
				return
			case <-ticker.C:
				sequence++
				for index, track := range []*webrtc.TrackLocalStaticRTP{lowTrack, mediumTrack, highTrack} {
					packet := &rtp.Packet{
						Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence,
							Timestamp: uint32(sequence) * 3000, SSRC: uint32(177 + index)},
						Payload: [][]byte{lowCiphertext, mediumCiphertext, highCiphertext}[index],
					}
					_ = packet.Header.SetExtension(midExtensionID, []byte(mid))
					_ = packet.Header.SetExtension(ridExtensionID, []byte(track.RID()))
					_ = track.WriteRTP(packet)
				}
				_ = audioTrack.WriteRTP(&rtp.Packet{
					Header: rtp.Header{
						Version: 2, PayloadType: 111, SequenceNumber: sequence,
						Timestamp: uint32(sequence) * 960, SSRC: 277,
					},
					Payload: audioCiphertext,
				})
			}
		}
	}()

	var remoteCamera *webrtc.TrackRemote
	select {
	case remoteCamera = <-receivedCamera:
	case brokerErr := <-brokerErrors:
		t.Fatalf("agent broker failed: %v", brokerErr)
	case <-time.After(15 * time.Second):
		t.Fatal("subscriber did not receive the federated camera layer")
	}
	var remoteAudio *webrtc.TrackRemote
	select {
	case remoteAudio = <-receivedAudio:
	case brokerErr := <-brokerErrors:
		t.Fatalf("agent broker failed: %v", brokerErr)
	case <-time.After(15 * time.Second):
		t.Fatal("publisher did not receive the reverse federated audio layer")
	}
	cameraPacketRead := make(chan *rtp.Packet, 1)
	go func() {
		packet, _, readErr := remoteCamera.ReadRTP()
		if readErr == nil {
			cameraPacketRead <- packet
		}
	}()
	select {
	case packet := <-cameraPacketRead:
		if !bytes.Equal(packet.Payload, mediumCiphertext) {
			t.Fatalf("federation selected the wrong layer or modified opaque ciphertext: %x", packet.Payload)
		}
	case brokerErr := <-brokerErrors:
		t.Fatalf("agent broker failed: %v", brokerErr)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out reading federated RTP")
	}
	audioPacketRead := make(chan *rtp.Packet, 1)
	go func() {
		packet, _, readErr := remoteAudio.ReadRTP()
		if readErr == nil {
			audioPacketRead <- packet
		}
	}()
	select {
	case packet := <-audioPacketRead:
		if !bytes.Equal(packet.Payload, audioCiphertext) {
			t.Fatalf("federation modified reverse opaque audio: %x", packet.Payload)
		}
	case brokerErr := <-brokerErrors:
		t.Fatalf("agent broker failed: %v", brokerErr)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out reading reverse federated RTP")
	}
}
