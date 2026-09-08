package main

import (
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestNativeMediaReceivesBrowserRTP(t *testing.T) {
	testNativeMediaReceivesBrowserRTP(t, false)
}

func TestNativeMediaReceivesEarlyICEBeforeAnswer(t *testing.T) {
	testNativeMediaReceivesBrowserRTP(t, true)
}

func testNativeMediaReceivesBrowserRTP(t *testing.T, earlyICE bool) {
	api, err := createWebRTCAPI()
	if err != nil {
		t.Fatal(err)
	}
	outgoing := make(chan map[string]any, 64)
	candidateSent := make(chan struct{})
	var candidateOnce sync.Once
	packager := &client{api: api}
	packager.sendOverride = func(value any) error {
		message, ok := value.(map[string]any)
		if ok {
			if _, answer := message["description"]; earlyICE && answer {
				select {
				case <-candidateSent:
				case <-time.After(2 * time.Second):
					return errors.New("test early ICE ordering unavailable")
				}
			}
			outgoing <- message
			if _, candidate := message["candidate"]; candidate {
				candidateOnce.Do(func() { close(candidateSent) })
			}
		}
		return nil
	}
	assignment := assignmentFrom(assignmentMessage(time.Now()))
	packager.assignment = assignment
	media, err := newNativeMediaSession(packager, assignment)
	if err != nil {
		t.Fatal(err)
	}
	assignment.Media = media
	defer media.close()

	browser, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	video, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"video", "native-packager-test",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = browser.AddTrack(video); err != nil {
		t.Fatal(err)
	}
	connected := make(chan struct{}, 1)
	browser.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	var signalingFailure, earlyCandidates atomic.Uint32
	browser.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		raw, marshalErr := json.Marshal(candidate.ToJSON())
		if marshalErr != nil {
			signalingFailure.CompareAndSwap(0, 4)
			return
		}
		if err := media.handle(assignmentSignalForTest(assignment, nil, raw)); err != nil {
			signalingFailure.CompareAndSwap(0, 5)
		}
	})

	stopSignaling := make(chan struct{})
	signalingDone := make(chan struct{})
	go func() {
		defer close(signalingDone)
		receiver := nativeBrowserSignalFixture{pc: browser}
		defer receiver.close()
		for {
			var message map[string]any
			select {
			case message = <-outgoing:
			case <-stopSignaling:
				return
			}
			if message["type"] != "assignment-signal" {
				continue
			}
			if description, ok := message["description"].(*webrtc.SessionDescription); ok && description != nil {
				if stage := receiver.description(*description); stage != 0 {
					signalingFailure.CompareAndSwap(0, stage)
				}
			}
			if candidate, ok := message["candidate"].(webrtc.ICECandidateInit); ok && candidate.Candidate != "" {
				early, stage := receiver.candidate(candidate)
				if early {
					earlyCandidates.Add(1)
				}
				if stage != 0 {
					signalingFailure.CompareAndSwap(0, stage)
				}
			}
		}
	}()
	defer func() {
		close(stopSignaling)
		<-signalingDone
	}()

	offer, err := browser.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = browser.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	if err = media.handle(assignmentSignalForTest(assignment, browser.LocalDescription(), nil)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Fatalf("browser-to-packager WebRTC connection did not become connected: signalStage=%d earlyCandidates=%d",
			signalingFailure.Load(), earlyCandidates.Load())
	}
	deadline := time.Now().Add(5 * time.Second)
	for media.packets.Load() == 0 && time.Now().Before(deadline) {
		if err = video.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 1, Timestamp: 3000}, Payload: []byte{0x10, 0x00}}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(25 * time.Millisecond)
	}
	if earlyICE && earlyCandidates.Load() == 0 {
		t.Fatal("test did not exercise early ICE before remote answer")
	}
	if signalingFailure.Load() != 0 || media.packets.Load() == 0 || media.bytes.Load() == 0 {
		packager.assignmentMu.Lock()
		state := assignment.State
		packager.assignmentMu.Unlock()
		t.Fatalf("native ingress failed: state=%s packets=%d bytes=%d signalStage=%d earlyCandidates=%d",
			state, media.packets.Load(), media.bytes.Load(), signalingFailure.Load(), earlyCandidates.Load())
	}
}

func TestNativeMediaAppliesConfiguredICETransportPolicy(t *testing.T) {
	api, err := createWebRTCAPI()
	if err != nil {
		t.Fatal(err)
	}
	packager := &client{api: api, cfg: config{iceTransportPolicy: webrtc.ICETransportPolicyRelay}}
	assignment := assignmentFrom(assignmentMessage(time.Now()))
	media, err := newNativeMediaSession(packager, assignment)
	if err != nil {
		t.Fatal(err)
	}
	defer media.close()
	if policy := media.pc.GetConfiguration().ICETransportPolicy; policy != webrtc.ICETransportPolicyRelay {
		t.Fatalf("unexpected ICE transport policy: %s", policy.String())
	}
}

func TestNativeMediaUsesAssignmentICEConfiguration(t *testing.T) {
	api, err := createWebRTCAPI()
	if err != nil {
		t.Fatal(err)
	}
	message := assignmentMessage(time.Now())
	message.Version = 3
	message.Profile.VideoEncoder = "libx264"
	message.Profile.SoftwareFallback = "libx264"
	message.ICEServers = []assignmentICEServer{{
		URLs: []string{"turn:turn.example.test:3478?transport=tcp"}, Username: "ephemeral-user",
		Credential: "ephemeral-password", CredentialType: "password",
	}}
	assignment := assignmentFrom(message)
	packager := &client{api: api, cfg: config{stunURLs: []string{"stun:static.example.test:3478"}}}
	media, err := newNativeMediaSession(packager, assignment)
	if err != nil {
		t.Fatal(err)
	}
	defer media.close()
	servers := media.pc.GetConfiguration().ICEServers
	if len(servers) != 1 || len(servers[0].URLs) != 1 || servers[0].URLs[0] != message.ICEServers[0].URLs[0] ||
		servers[0].Username != "ephemeral-user" || servers[0].Credential != "ephemeral-password" ||
		servers[0].CredentialType != webrtc.ICECredentialTypePassword {
		t.Fatalf("assignment ICE configuration was not applied: %#v", servers)
	}
}

func assignmentSignalForTest(
	assignment *packagerAssignment,
	description *webrtc.SessionDescription,
	candidate json.RawMessage,
) serverMessage {
	return serverMessage{
		Version: 1, Type: "assignment-peer-signal", AssignmentID: assignment.AssignmentID,
		PublisherPeerID: assignment.PublisherPeerID, ProgramEpoch: assignment.ProgramEpoch,
		FencingRevision: assignment.FencingRevision, Description: description, Candidate: candidate,
	}
}
