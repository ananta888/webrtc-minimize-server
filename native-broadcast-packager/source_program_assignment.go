package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Additive v4 contract. This is deliberately not an alternate interpretation
// of the legacy publisherPeerId or of the first incoming source lease.
type sourceProgramAssignment struct {
	Version         int                            `json:"version"`
	Type            string                         `json:"type"`
	InputMode       string                         `json:"inputMode"`
	AssignmentID    string                         `json:"assignmentId"`
	RoomID          string                         `json:"roomId"`
	ProgramID       string                         `json:"programId"`
	ProgramEpoch    int64                          `json:"programEpoch"`
	LeaseID         string                         `json:"leaseId"`
	FencingRevision int64                          `json:"fencingRevision"`
	ResourceRef     string                         `json:"resourceRef"`
	Profile         assignmentProfile              `json:"profile"`
	ICEServers      []assignmentICEServer          `json:"iceServers"`
	ExpiresAt       int64                          `json:"expiresAt"`
	SourceContext   sourceProgramAssignmentContext `json:"sourceContext"`
}

type sourceProgramAssignmentContext struct {
	Schema           string `json:"schema"`
	TenantID         string `json:"tenantId"`
	RoomEpoch        int64  `json:"roomEpoch"`
	GranteeDeviceRef string `json:"granteeDeviceRef"`
	FrameEnvelope    string `json:"frameEnvelope"`
}

const maximumSourceProgramAssignmentBytes = 65536

func parseSourceProgramAssignment(raw []byte, now time.Time) (sourceProgramAssignment, error) {
	var a sourceProgramAssignment
	if len(raw) == 0 || len(raw) > maximumSourceProgramAssignmentBytes {
		return a, errors.New("source program assignment size")
	}
	// Check exact key spelling and duplicates before encoding/json can fold
	// aliases or overwrite a previous value. Typed decoding then checks values.
	if !validSourceProgramAssignmentShape(raw) {
		return a, errors.New("source program assignment shape")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&a) != nil || !validSourceProgramAssignment(a, now) {
		return sourceProgramAssignment{}, errors.New("source program assignment denied")
	}
	return a, nil
}

func validSourceProgramAssignment(a sourceProgramAssignment, now time.Time) bool {
	s := a.SourceContext
	p := a.Profile
	if a.Version != 4 || a.Type != "assignment-prepare" || a.InputMode != "trusted-sframe-v1" ||
		!assignmentIDPattern.MatchString(a.AssignmentID) || !roomIDPattern.MatchString(a.RoomID) || !programIDPattern.MatchString(a.ProgramID) ||
		!leaseIDPattern.MatchString(a.LeaseID) || !resourceIDPattern.MatchString(a.ResourceRef) ||
		a.ProgramEpoch < 1 || a.ProgramEpoch > sourceVideoSceneMaxRevision || a.FencingRevision < 1 || a.FencingRevision > sourceVideoSceneMaxRevision ||
		a.ExpiresAt <= now.UnixMilli() || a.ExpiresAt > now.Add(2*time.Minute).UnixMilli() || a.ExpiresAt > sourceVideoSceneMaxRevision ||
		s.Schema != "ananta.trusted-source-program-context.v1" || !sourceProgramTenant.MatchString(s.TenantID) ||
		!sourceProgramDevice.MatchString(s.GranteeDeviceRef) || s.RoomEpoch < 1 || s.RoomEpoch > sourceVideoSceneMaxRevision || s.FrameEnvelope != "codec-prefix-v1" ||
		p.ProfileID != "h264-aac-720p-v1" || !oneOf(p.VideoEncoder, "libx264", "h264_nvenc", "h264_videotoolbox") || p.SoftwareFallback != "libx264" ||
		p.MaximumQueueFrames < 1 || p.MaximumQueueFrames > 120 || p.KeyframeIntervalSeconds < 1 || p.KeyframeIntervalSeconds > 10 ||
		len(p.Renditions) < 1 || len(p.Renditions) > 3 || !validSourceProgramAssignmentICE(a.ICEServers) {
		return false
	}
	seen := map[string]bool{}
	for _, r := range p.Renditions {
		if !oneOf(r.ID, "low", "medium", "high") || seen[r.ID] || !validSourceVideoSize(r.Width, r.Height) || r.Width < 160 || r.Height < 90 ||
			r.FramesPerSecond < 1 || r.FramesPerSecond > 60 || r.VideoBitsPerSecond < 100000 || r.VideoBitsPerSecond > 10000000 ||
			r.AudioBitsPerSecond < 16000 || r.AudioBitsPerSecond > 320000 {
			return false
		}
		seen[r.ID] = true
	}
	return true
}

func validSourceProgramAssignmentICE(servers []assignmentICEServer) bool {
	if servers == nil {
		return false
	}
	if len(servers) == 0 {
		return true
	} // Explicit direct-ICE-only configuration.
	if !validAssignmentICEServers(servers) {
		return false
	}
	// Match the closed schema: a server entry is either STUN-only or TURN-only.
	// Legacy v3 parsing stays unchanged; mixed credentials cannot leak to STUN.
	for _, s := range servers {
		turn := s.CredentialType == "password"
		for _, url := range s.URLs {
			for _, character := range url {
				if character < 0x21 || character > 0x7e {
					return false
				}
			}
			if turn && !(strings.HasPrefix(url, "turn:") || strings.HasPrefix(url, "turns:")) ||
				!turn && !(strings.HasPrefix(url, "stun:") || strings.HasPrefix(url, "stuns:")) {
				return false
			}
		}
	}
	return true
}

// Shape/scope projection only. The runtime adapter must also prove the current
// authenticated assignment and owner consent; parsing JSON grants no authority.
func (a sourceProgramAssignment) scopeForDevice(device string, now time.Time) (sourceProgramScope, error) {
	if !validSourceProgramAssignment(a, now) || device != a.SourceContext.GranteeDeviceRef {
		return sourceProgramScope{}, errors.New("source program device binding denied")
	}
	return sourceProgramScope{tenantID: a.SourceContext.TenantID, deviceRef: device, roomID: a.RoomID, roomEpoch: a.SourceContext.RoomEpoch,
		programID: a.ProgramID, programEpoch: a.ProgramEpoch, assignmentID: a.AssignmentID, writerLeaseID: a.LeaseID, fencingRevision: a.FencingRevision}, nil
}
