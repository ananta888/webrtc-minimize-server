package main

import (
	"testing"

	"github.com/pion/webrtc/v4"
)

type fakeRemoteICECandidateTarget struct {
	description *webrtc.SessionDescription
	added       []webrtc.ICECandidateInit
}

func (f *fakeRemoteICECandidateTarget) RemoteDescription() *webrtc.SessionDescription {
	return f.description
}

func (f *fakeRemoteICECandidateTarget) AddICECandidate(candidate webrtc.ICECandidateInit) error {
	f.added = append(f.added, candidate)
	return nil
}

func iceCandidateForGeneration(generation string) webrtc.ICECandidateInit {
	return webrtc.ICECandidateInit{
		Candidate:        "candidate:1 1 udp 1 192.0.2.1 40000 typ host",
		UsernameFragment: &generation,
	}
}

func TestRemoteICECandidateWaitsForMatchingDescriptionGeneration(t *testing.T) {
	target := &fakeRemoteICECandidateTarget{description: &webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  "v=0\r\na=ice-ufrag:old\r\n",
	}}
	pending := []webrtc.ICECandidateInit{}
	future := iceCandidateForGeneration("future")
	if err := addOrQueueRemoteICECandidate(target, &pending, future); err != nil {
		t.Fatal(err)
	}
	if len(target.added) != 0 || len(pending) != 1 {
		t.Fatal("future-generation ICE candidate was not bounded in the pending queue")
	}
	target.description = &webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  "v=0\r\na=ice-ufrag:future\r\n",
	}
	if err := applyQueuedRemoteICECandidates(target, &pending); err != nil {
		t.Fatal(err)
	}
	if len(target.added) != 1 || len(pending) != 0 {
		t.Fatal("matching future-generation ICE candidate was not applied exactly once")
	}
}

func TestQueuedRemoteICECandidatesDiscardStaleGenerations(t *testing.T) {
	target := &fakeRemoteICECandidateTarget{description: &webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  "v=0\r\na=ice-ufrag:current\r\n",
	}}
	pending := []webrtc.ICECandidateInit{
		iceCandidateForGeneration("stale"),
		iceCandidateForGeneration("current"),
	}
	if err := applyQueuedRemoteICECandidates(target, &pending); err != nil {
		t.Fatal(err)
	}
	if len(target.added) != 1 || target.added[0].UsernameFragment == nil ||
		*target.added[0].UsernameFragment != "current" {
		t.Fatal("stale remote ICE generations were not discarded")
	}
}
