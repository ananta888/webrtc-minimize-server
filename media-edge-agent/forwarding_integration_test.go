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

type capturedControl struct {
	Type        string                     `json:"type"`
	RoomID      string                     `json:"roomId"`
	PeerID      string                     `json:"peerId"`
	RouteEpoch  int64                      `json:"routeEpoch"`
	Description *webrtc.SessionDescription `json:"description"`
	Candidate   json.RawMessage            `json:"candidate"`
}

type fakeControl struct{ messages chan capturedControl }

func (f *fakeControl) send(value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var message capturedControl
	if err = json.Unmarshal(raw, &message); err != nil {
		return err
	}
	select {
	case f.messages <- message:
		return nil
	case <-time.After(time.Second):
		return fmt.Errorf("fake control queue full")
	}
}

func newBrowserPeer(t *testing.T, id string) *webrtc.PeerConnection {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return pc
}

func gatheredLocalDescription(t *testing.T, pc *webrtc.PeerConnection) webrtc.SessionDescription {
	t.Helper()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ICE gathering timeout")
	}
	return *pc.LocalDescription()
}

func TestNativeAgentSelectsOpaqueSimulcastLayerPerSubscriber(t *testing.T) {
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
	control := &fakeControl{messages: make(chan capturedControl, 512)}
	agent.setSignaling(control)
	defer agent.close()
	now := time.Now()
	const (
		roomID           = "room-123456"
		publisherID      = "0123456789abcdef"
		lowSubscriberID  = "1111111111111111"
		highSubscriberID = "fedcba9876543210"
	)
	if err = agent.applySync([]agentLease{{
		Version: 3, Type: "agent-lease", RoomID: roomID, Role: "primary",
		MembershipEpoch: 1, RouteEpoch: 1, LeaseExpiresAt: now.Add(30 * time.Second).UnixMilli(),
		Peers: []leasePeer{
			{ID: publisherID, Connect: true, Publish: true, Subscribe: true},
			{ID: lowSubscriberID, Connect: true, Publish: false, Subscribe: true},
			{ID: highSubscriberID, Connect: true, Publish: false, Subscribe: true},
		},
		Subscriptions: []subscriptionPlan{
			{
				SubscriberPeerID: lowSubscriberID, PublisherPeerID: publisherID,
				PublicationID: "camera-track", Source: "camera", Enabled: true,
				PreferredLayer: "low", MaximumLayer: "low", Revision: 1,
			},
			{
				SubscriberPeerID: highSubscriberID, PublisherPeerID: publisherID,
				PublicationID: "camera-track", Source: "camera", Enabled: true,
				PreferredLayer: "high", MaximumLayer: "high", Revision: 2,
			},
		},
		FederationLinks:   []federationLink{},
		FederationRoutes:  []federationRoute{},
		FederationDemands: []federationDemand{},
		ICEServers:        []webrtc.ICEServer{},
	}}, now); err != nil {
		t.Fatal(err)
	}

	publisher := newBrowserPeer(t, publisherID)
	lowSubscriber := newBrowserPeer(t, lowSubscriberID)
	highSubscriber := newBrowserPeer(t, highSubscriberID)
	lowPublication, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"camera-track", "publisher-stream", webrtc.WithRTPStreamID("q"),
	)
	if err != nil {
		t.Fatal(err)
	}
	mediumPublication, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"camera-track", "publisher-stream", webrtc.WithRTPStreamID("h"),
	)
	if err != nil {
		t.Fatal(err)
	}
	highPublication, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"camera-track", "publisher-stream", webrtc.WithRTPStreamID("f"),
	)
	if err != nil {
		t.Fatal(err)
	}
	sender, err := publisher.AddTrack(lowPublication)
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.AddEncoding(mediumPublication); err != nil {
		t.Fatal(err)
	}
	if err = sender.AddEncoding(highPublication); err != nil {
		t.Fatal(err)
	}
	if _, err = lowSubscriber.CreateDataChannel("bootstrap", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = highSubscriber.CreateDataChannel("bootstrap", nil); err != nil {
		t.Fatal(err)
	}

	receivedTracks := map[string]chan *webrtc.TrackRemote{
		lowSubscriberID:  make(chan *webrtc.TrackRemote, 1),
		highSubscriberID: make(chan *webrtc.TrackRemote, 1),
	}
	lowSubscriber.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		receivedTracks[lowSubscriberID] <- track
	})
	highSubscriber.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		receivedTracks[highSubscriberID] <- track
	})
	clients := map[string]*webrtc.PeerConnection{
		publisherID: publisher, lowSubscriberID: lowSubscriber, highSubscriberID: highSubscriber,
	}
	var clientsMu sync.Mutex
	for peerID, pc := range clients {
		description := gatheredLocalDescription(t, pc)
		if err = agent.handleSignal(serverMessage{
			Type: "peer-signal", RoomID: roomID, PeerID: peerID, RouteEpoch: 1,
			Description: &description,
		}); err != nil {
			t.Fatal(err)
		}
	}

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case message := <-control.messages:
				pc := clients[message.PeerID]
				if pc == nil {
					continue
				}
				clientsMu.Lock()
				if message.Description != nil {
					if message.Description.Type == webrtc.SDPTypeOffer {
						if pc.SetRemoteDescription(*message.Description) == nil {
							answer, answerErr := pc.CreateAnswer(nil)
							if answerErr == nil && pc.SetLocalDescription(answer) == nil {
								_ = agent.handleSignal(serverMessage{
									Type: "peer-signal", RoomID: roomID, PeerID: message.PeerID,
									RouteEpoch: 1, Description: &answer,
								})
							}
						}
					} else {
						_ = pc.SetRemoteDescription(*message.Description)
					}
				} else if len(message.Candidate) > 0 && !bytes.Equal(bytes.TrimSpace(message.Candidate), []byte("null")) {
					var candidate webrtc.ICECandidateInit
					if json.Unmarshal(message.Candidate, &candidate) == nil {
						_ = pc.AddICECandidate(candidate)
					}
				}
				clientsMu.Unlock()
			}
		}
	}()

	lowCiphertext := []byte{0x88, 0x08, 0x6c, 0x6f, 0x77, 0xde, 0xad, 0xbe, 0xef}
	mediumCiphertext := []byte{0x88, 0x08, 0x6d, 0x69, 0x64, 0xde, 0xad, 0xbe, 0xef}
	highCiphertext := []byte{0x88, 0x08, 0x68, 0x69, 0x67, 0x68, 0xde, 0xad, 0xbe, 0xef}
	stopWriter := make(chan struct{})
	defer close(stopWriter)
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
		t.Fatal("simulcast MID/RID header extensions were not negotiated")
	}
	mid := publisher.GetTransceivers()[0].Mid()
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-stopWriter:
				return
			case <-ticker.C:
				sequence++
				for index, publication := range []*webrtc.TrackLocalStaticRTP{
					lowPublication, mediumPublication, highPublication,
				} {
					payload := [][]byte{lowCiphertext, mediumCiphertext, highCiphertext}[index]
					packet := &rtp.Packet{
						Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence,
							Timestamp: uint32(sequence) * 3000, SSRC: uint32(77 + index)},
						Payload: payload,
					}
					_ = packet.Header.SetExtension(midExtensionID, []byte(mid))
					_ = packet.Header.SetExtension(ridExtensionID, []byte(publication.RID()))
					_ = publication.WriteRTP(packet)
				}
			}
		}
	}()
	for subscriberID, expected := range map[string][]byte{
		lowSubscriberID:  lowCiphertext,
		highSubscriberID: highCiphertext,
	} {
		var remote *webrtc.TrackRemote
		select {
		case remote = <-receivedTracks[subscriberID]:
		case <-time.After(10 * time.Second):
			t.Fatalf("subscriber %s did not receive relayed track", subscriberID)
		}
		packetRead := make(chan *rtp.Packet, 1)
		go func() {
			packet, _, readErr := remote.ReadRTP()
			if readErr == nil {
				packetRead <- packet
			}
		}()
		select {
		case packet := <-packetRead:
			if !bytes.Equal(packet.Payload, expected) {
				t.Fatalf("subscriber %s received the wrong layer or modified SFrame ciphertext", subscriberID)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out reading relayed RTP for %s", subscriberID)
		}
	}
}
