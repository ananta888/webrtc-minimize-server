package main

import (
	"fmt"
	"strings"

	"github.com/pion/webrtc/v4"
)

const maximumPendingRemoteICECandidates = 256

type remoteICECandidateTarget interface {
	RemoteDescription() *webrtc.SessionDescription
	AddICECandidate(webrtc.ICECandidateInit) error
}

func remoteICEUfrags(description *webrtc.SessionDescription) map[string]struct{} {
	values := map[string]struct{}{}
	if description == nil {
		return values
	}
	for _, line := range strings.Split(description.SDP, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "a=ice-ufrag:") {
			continue
		}
		if value := strings.TrimSpace(strings.TrimPrefix(line, "a=ice-ufrag:")); value != "" {
			values[value] = struct{}{}
		}
	}
	return values
}

func remoteICECandidateMatchesDescription(
	candidate webrtc.ICECandidateInit,
	description *webrtc.SessionDescription,
) bool {
	if description == nil {
		return false
	}
	if candidate.UsernameFragment == nil || strings.TrimSpace(*candidate.UsernameFragment) == "" {
		return true
	}
	_, present := remoteICEUfrags(description)[strings.TrimSpace(*candidate.UsernameFragment)]
	return present
}

func addOrQueueRemoteICECandidate(
	target remoteICECandidateTarget,
	pending *[]webrtc.ICECandidateInit,
	candidate webrtc.ICECandidateInit,
) error {
	if remoteICECandidateMatchesDescription(candidate, target.RemoteDescription()) {
		return target.AddICECandidate(candidate)
	}
	if len(*pending) >= maximumPendingRemoteICECandidates {
		return fmt.Errorf("remote ICE candidate queue full")
	}
	*pending = append(*pending, candidate)
	return nil
}

func applyQueuedRemoteICECandidates(
	target remoteICECandidateTarget,
	pending *[]webrtc.ICECandidateInit,
) error {
	description := target.RemoteDescription()
	queued := *pending
	*pending = nil
	for _, candidate := range queued {
		if !remoteICECandidateMatchesDescription(candidate, description) {
			continue
		}
		if err := target.AddICECandidate(candidate); err != nil {
			return err
		}
	}
	return nil
}
