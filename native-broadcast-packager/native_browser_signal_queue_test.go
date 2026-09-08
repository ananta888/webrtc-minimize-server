package main

import (
	"errors"
	"reflect"
	"testing"

	"github.com/pion/webrtc/v4"
)

type nativeBrowserSignalFake struct {
	remote         *webrtc.SessionDescription
	added          []string
	descriptionErr bool
	candidateErr   bool
}

func (pc *nativeBrowserSignalFake) RemoteDescription() *webrtc.SessionDescription { return pc.remote }
func (pc *nativeBrowserSignalFake) SetRemoteDescription(value webrtc.SessionDescription) error {
	if pc.descriptionErr {
		return errors.New("fixture description failure")
	}
	pc.remote = &value
	return nil
}
func (pc *nativeBrowserSignalFake) AddICECandidate(value webrtc.ICECandidateInit) error {
	if pc.remote == nil || pc.candidateErr {
		return errors.New("fixture candidate failure")
	}
	pc.added = append(pc.added, value.Candidate)
	return nil
}

func TestNativeBrowserSignalQueueOrdersEarlyAndLateCandidates(t *testing.T) {
	pc := &nativeBrowserSignalFake{}
	receiver := nativeBrowserSignalFixture{pc: pc}
	for _, value := range []string{"first", "second"} {
		if early, stage := receiver.candidate(webrtc.ICECandidateInit{Candidate: value}); !early || stage != 0 {
			t.Fatal("early candidate was not queued")
		}
	}
	if len(pc.added) != 0 || len(receiver.pending) != 2 {
		t.Fatal("candidate applied before answer")
	}
	if stage := receiver.description(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer}); stage != 0 {
		t.Fatalf("answer failed: stage=%d", stage)
	}
	if len(receiver.pending) != 0 {
		t.Fatal("flushed candidates retained")
	}
	if early, stage := receiver.candidate(webrtc.ICECandidateInit{Candidate: "third"}); early || stage != 0 {
		t.Fatal("late candidate was not applied")
	}
	if !reflect.DeepEqual(pc.added, []string{"first", "second", "third"}) {
		t.Fatal("candidate order or exact-once delivery violated")
	}
}

func TestNativeBrowserSignalQueueBoundsAndCloses(t *testing.T) {
	receiver := nativeBrowserSignalFixture{pc: &nativeBrowserSignalFake{}}
	for index := 0; index < 128; index++ {
		if early, stage := receiver.candidate(webrtc.ICECandidateInit{Candidate: "fixture"}); !early || stage != 0 {
			t.Fatal("candidate rejected below queue limit")
		}
	}
	if early, stage := receiver.candidate(webrtc.ICECandidateInit{Candidate: "overflow"}); !early || stage != 6 {
		t.Fatal("queue overflow was not terminal")
	}
	assertNativeBrowserSignalClosed(t, &receiver)
}

func TestNativeBrowserSignalQueuePreservesFailures(t *testing.T) {
	for _, test := range []struct {
		name        string
		description bool
		queued      bool
		stage       uint32
	}{
		{"description", true, true, 1},
		{"queued-candidate", false, true, 3},
		{"late-candidate", false, false, 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			pc := &nativeBrowserSignalFake{descriptionErr: test.description, candidateErr: !test.description}
			receiver := nativeBrowserSignalFixture{pc: pc}
			if test.queued {
				receiver.candidate(webrtc.ICECandidateInit{Candidate: "fixture"})
			}
			stage := receiver.description(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer})
			if !test.queued {
				if stage != 0 {
					t.Fatal("unexpected answer failure")
				}
				_, stage = receiver.candidate(webrtc.ICECandidateInit{Candidate: "fixture"})
			}
			if stage != test.stage {
				t.Fatalf("wrong fixed failure stage: %d", stage)
			}
			assertNativeBrowserSignalClosed(t, &receiver)
		})
	}
}

func TestNativeBrowserSignalQueueStopClearsPending(t *testing.T) {
	receiver := nativeBrowserSignalFixture{pc: &nativeBrowserSignalFake{}}
	receiver.candidate(webrtc.ICECandidateInit{Candidate: "fixture"})
	retained := receiver.pending
	receiver.close()
	receiver.close()
	if retained[0].Candidate != "" {
		t.Fatal("pending storage retained candidate")
	}
	assertNativeBrowserSignalClosed(t, &receiver)
}

func assertNativeBrowserSignalClosed(t *testing.T, receiver *nativeBrowserSignalFixture) {
	t.Helper()
	if !receiver.stopped || len(receiver.pending) != 0 {
		t.Fatal("receiver not closed and cleared")
	}
	if stage := receiver.description(webrtc.SessionDescription{}); stage != 8 {
		t.Fatal("closed receiver accepted answer")
	}
	if _, stage := receiver.candidate(webrtc.ICECandidateInit{}); stage != 8 {
		t.Fatal("closed receiver accepted candidate")
	}
}
