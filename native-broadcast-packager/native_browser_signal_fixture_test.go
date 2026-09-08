package main

import "github.com/pion/webrtc/v4"

// This test-only receiver mirrors the Angular publisher's bounded early-ICE
// queue. One signaling consumer owns it; it grants no production authority.
type nativeBrowserSignalPort interface {
	RemoteDescription() *webrtc.SessionDescription
	SetRemoteDescription(webrtc.SessionDescription) error
	AddICECandidate(webrtc.ICECandidateInit) error
}

type nativeBrowserSignalFixture struct {
	pc      nativeBrowserSignalPort
	pending []webrtc.ICECandidateInit
	stopped bool
}

// Fixed diagnostic stages contain no SDP, candidates, or underlying errors.
func (receiver *nativeBrowserSignalFixture) description(value webrtc.SessionDescription) uint32 {
	if receiver.stopped {
		return 8
	}
	if err := receiver.pc.SetRemoteDescription(value); err != nil {
		return receiver.fail(1)
	}
	for _, candidate := range receiver.pending {
		if err := receiver.pc.AddICECandidate(candidate); err != nil {
			return receiver.fail(3)
		}
	}
	clear(receiver.pending)
	receiver.pending = nil
	return 0
}

func (receiver *nativeBrowserSignalFixture) candidate(value webrtc.ICECandidateInit) (early bool, stage uint32) {
	if receiver.stopped {
		return false, 8
	}
	if receiver.pc.RemoteDescription() == nil {
		if len(receiver.pending) >= 128 {
			return true, receiver.fail(6)
		}
		receiver.pending = append(receiver.pending, value)
		return true, 0
	}
	if err := receiver.pc.AddICECandidate(value); err != nil {
		return false, receiver.fail(3)
	}
	return false, 0
}

func (receiver *nativeBrowserSignalFixture) fail(stage uint32) uint32 {
	receiver.close()
	return stage
}

func (receiver *nativeBrowserSignalFixture) close() {
	receiver.stopped = true
	clear(receiver.pending)
	receiver.pending = nil
}
