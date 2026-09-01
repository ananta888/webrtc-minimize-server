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

func TestNativeAgentForwardsOpaqueRTPPayloadBetweenIsolatedPeerConnections(t *testing.T) {
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
		roomID       = "room-123456"
		publisherID  = "0123456789abcdef"
		subscriberID = "fedcba9876543210"
	)
	if err = agent.applySync([]agentLease{{
		Version: 2, Type: "agent-lease", RoomID: roomID, Role: "primary",
		MembershipEpoch: 1, RouteEpoch: 1, LeaseExpiresAt: now.Add(30 * time.Second).UnixMilli(),
		Peers: []leasePeer{{ID: publisherID, Publish: true}, {ID: subscriberID, Publish: false}},
	}}, now); err != nil {
		t.Fatal(err)
	}

	publisher := newBrowserPeer(t, publisherID)
	subscriber := newBrowserPeer(t, subscriberID)
	publication, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"camera-track", "publisher-stream",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = publisher.AddTrack(publication); err != nil {
		t.Fatal(err)
	}
	if _, err = subscriber.CreateDataChannel("bootstrap", nil); err != nil {
		t.Fatal(err)
	}

	clients := map[string]*webrtc.PeerConnection{publisherID: publisher, subscriberID: subscriber}
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

	receivedTrack := make(chan *webrtc.TrackRemote, 1)
	subscriber.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		select {
		case receivedTrack <- track:
		default:
		}
	})
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

	ciphertext := []byte{0x88, 0x08, 0x42, 0x73, 0x46, 0x72, 0x61, 0x6d, 0x65, 0xde, 0xad, 0xbe, 0xef}
	stopWriter := make(chan struct{})
	defer close(stopWriter)
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
				_ = publication.WriteRTP(&rtp.Packet{
					Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence,
						Timestamp: uint32(sequence) * 3000, SSRC: 77},
					Payload: ciphertext,
				})
			}
		}
	}()
	var remote *webrtc.TrackRemote
	select {
	case remote = <-receivedTrack:
	case <-time.After(10 * time.Second):
		t.Fatal("subscriber did not receive relayed track")
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
		if !bytes.Equal(packet.Payload, ciphertext) {
			t.Fatal("SFrame ciphertext changed in native fanout")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out reading relayed RTP")
	}
}
