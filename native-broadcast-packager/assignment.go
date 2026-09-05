package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"sync/atomic"
	"time"
)

var assignmentIDPattern = regexp.MustCompile(`^asn_[A-Za-z0-9_-]{16,64}$`)
var roomIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)
var programIDPattern = regexp.MustCompile(`^prg_[A-Za-z0-9_-]{16,64}$`)
var leaseIDPattern = regexp.MustCompile(`^lea_[A-Za-z0-9_-]{16,64}$`)
var resourceIDPattern = regexp.MustCompile(`^res_[A-Za-z0-9_-]{16,64}$`)
var reasonCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)
var peerIDPattern = regexp.MustCompile(`^[a-f0-9]{16}$`)

type assignmentRendition struct {
	ID                 string `json:"id"`
	Width              int    `json:"width"`
	Height             int    `json:"height"`
	FramesPerSecond    int    `json:"framesPerSecond"`
	VideoBitsPerSecond int    `json:"videoBitsPerSecond"`
	AudioBitsPerSecond int    `json:"audioBitsPerSecond"`
}

type assignmentProfile struct {
	ProfileID               string                `json:"profileId"`
	VideoEncoder            string                `json:"videoEncoder,omitempty"`
	SoftwareFallback        string                `json:"softwareFallback,omitempty"`
	MaximumQueueFrames      int                   `json:"maximumQueueFrames"`
	KeyframeIntervalSeconds int                   `json:"keyframeIntervalSeconds"`
	Renditions              []assignmentRendition `json:"renditions"`
}

type packagerAssignment struct {
	AssignmentID    string
	RoomID          string
	ProgramID       string
	PublisherPeerID string
	ProgramEpoch    int
	LeaseID         string
	FencingRevision int
	ResourceRef     string
	Profile         assignmentProfile
	expiresAt       atomic.Int64
	State           string
	Media           *nativeMediaSession
}

func validAssignmentPrepare(message serverMessage, now time.Time) bool {
	if !assignmentIDPattern.MatchString(message.AssignmentID) || !roomIDPattern.MatchString(message.RoomID) ||
		!programIDPattern.MatchString(message.ProgramID) || !peerIDPattern.MatchString(message.PublisherPeerID) || message.ProgramEpoch < 1 ||
		!leaseIDPattern.MatchString(message.LeaseID) || message.FencingRevision < 1 ||
		!resourceIDPattern.MatchString(message.ResourceRef) || message.ExpiresAt <= now.UnixMilli() ||
		message.ExpiresAt > now.Add(2*time.Minute).UnixMilli() || message.Profile.ProfileID != "h264-aac-720p-v1" ||
		message.Profile.MaximumQueueFrames < 1 || message.Profile.MaximumQueueFrames > 120 ||
		message.Profile.KeyframeIntervalSeconds < 1 || message.Profile.KeyframeIntervalSeconds > 10 ||
		len(message.Profile.Renditions) < 1 || len(message.Profile.Renditions) > 3 {
		return false
	}
	if message.Version == 1 {
		if message.Profile.VideoEncoder != "" || message.Profile.SoftwareFallback != "" {
			return false
		}
	} else if message.Version == 2 {
		if !oneOf(message.Profile.VideoEncoder, "libx264", "h264_nvenc", "h264_videotoolbox") ||
			message.Profile.SoftwareFallback != "libx264" {
			return false
		}
	} else {
		return false
	}
	seen := map[string]bool{}
	for _, rendition := range message.Profile.Renditions {
		if !oneOf(rendition.ID, "low", "medium", "high") || seen[rendition.ID] ||
			rendition.Width < 160 || rendition.Width > 1920 || rendition.Height < 90 || rendition.Height > 1080 ||
			rendition.FramesPerSecond < 1 || rendition.FramesPerSecond > 60 ||
			rendition.VideoBitsPerSecond < 100000 || rendition.VideoBitsPerSecond > 10000000 ||
			rendition.AudioBitsPerSecond < 16000 || rendition.AudioBitsPerSecond > 320000 {
			return false
		}
		seen[rendition.ID] = true
	}
	return true
}

func assignmentFrom(message serverMessage) *packagerAssignment {
	assignment := &packagerAssignment{
		AssignmentID: message.AssignmentID, RoomID: message.RoomID, ProgramID: message.ProgramID,
		PublisherPeerID: message.PublisherPeerID,
		ProgramEpoch:    message.ProgramEpoch, LeaseID: message.LeaseID, FencingRevision: message.FencingRevision,
		ResourceRef: message.ResourceRef, Profile: message.Profile, State: "ready",
	}
	assignment.expiresAt.Store(message.ExpiresAt)
	return assignment
}

func sameAssignment(left *packagerAssignment, right serverMessage) bool {
	if left == nil {
		return false
	}
	leftJSON, _ := json.Marshal(left.Profile)
	rightJSON, _ := json.Marshal(right.Profile)
	return left.AssignmentID == right.AssignmentID && left.RoomID == right.RoomID &&
		left.ProgramID == right.ProgramID && left.ProgramEpoch == right.ProgramEpoch &&
		left.PublisherPeerID == right.PublisherPeerID &&
		left.LeaseID == right.LeaseID && left.FencingRevision == right.FencingRevision &&
		left.ResourceRef == right.ResourceRef && left.expiresAt.Load() == right.ExpiresAt && bytes.Equal(leftJSON, rightJSON)
}

func allowedServerFields(messageType string) map[string]bool {
	common := map[string]map[string]bool{
		"packager-challenge":     {"version": true, "type": true, "nonce": true, "expiresAt": true},
		"packager-enrolled":      {"version": true, "type": true, "packagerId": true, "keyFingerprint": true},
		"packager-authenticated": {"version": true, "type": true, "packagerId": true},
		"room-consent-sync":      {"version": true, "type": true, "roomIds": true},
		"capability-accepted":    {"version": true, "type": true, "observedAt": true},
		"packager-error":         {"version": true, "type": true, "code": true},
		"assignment-prepare": {
			"version": true, "type": true, "assignmentId": true, "roomId": true, "programId": true,
			"publisherPeerId": true,
			"programEpoch":    true, "leaseId": true, "fencingRevision": true, "resourceRef": true,
			"profile": true, "expiresAt": true,
		},
		"assignment-stop": {
			"version": true, "type": true, "assignmentId": true, "programEpoch": true,
			"fencingRevision": true, "reasonCode": true,
		},
		"assignment-renew": {
			"version": true, "type": true, "assignmentId": true, "programEpoch": true,
			"fencingRevision": true, "expiresAt": true,
		},
		"assignment-peer-signal": {
			"version": true, "type": true, "assignmentId": true, "publisherPeerId": true,
			"programEpoch": true, "fencingRevision": true, "description": true, "candidate": true,
		},
	}
	return common[messageType]
}

func decodeServerMessage(raw []byte) (serverMessage, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return serverMessage{}, errors.New("invalid control message")
	}
	var messageType string
	if json.Unmarshal(fields["type"], &messageType) != nil {
		return serverMessage{}, errors.New("invalid control message")
	}
	allowed := allowedServerFields(messageType)
	if allowed == nil {
		return serverMessage{}, errors.New("unknown control message")
	}
	for field := range fields {
		if !allowed[field] {
			return serverMessage{}, errors.New("unknown control message field")
		}
	}
	if messageType == "assignment-peer-signal" {
		_, hasDescription := fields["description"]
		_, hasCandidate := fields["candidate"]
		if hasDescription == hasCandidate {
			return serverMessage{}, errors.New("invalid assignment peer signal")
		}
		delete(allowed, map[bool]string{true: "candidate", false: "description"}[hasDescription])
	}
	if len(fields) != len(allowed) {
		return serverMessage{}, errors.New("invalid control message fields")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var message serverMessage
	if decoder.Decode(&message) != nil || (message.Version != 1 && (message.Version != 2 || messageType != "assignment-prepare")) {
		return serverMessage{}, errors.New("invalid control message")
	}
	return message, nil
}

func (c *client) assignmentStatus(assignment *packagerAssignment, state, reasonCode string) map[string]any {
	return map[string]any{
		"version": 1, "type": "assignment-status", "assignmentId": assignment.AssignmentID,
		"programEpoch": assignment.ProgramEpoch, "fencingRevision": assignment.FencingRevision,
		"state": state, "reasonCode": reasonCode, "observedAt": time.Now().UnixMilli(),
	}
}

func (c *client) renewAssignment(message serverMessage, now time.Time) error {
	if !assignmentIDPattern.MatchString(message.AssignmentID) || message.ProgramEpoch < 1 || message.FencingRevision < 1 ||
		message.ExpiresAt <= now.UnixMilli() || message.ExpiresAt > now.Add(2*time.Minute).UnixMilli() {
		return errors.New("invalid assignment renewal")
	}
	c.assignmentMu.Lock()
	defer c.assignmentMu.Unlock()
	assignment := c.assignment
	if assignment == nil || assignment.AssignmentID != message.AssignmentID ||
		assignment.ProgramEpoch != message.ProgramEpoch || assignment.FencingRevision != message.FencingRevision ||
		assignment.expiresAt.Load() <= now.UnixMilli() {
		return errors.New("stale assignment renewal")
	}
	assignment.expiresAt.Store(message.ExpiresAt)
	return nil
}

func (c *client) prepareAssignment(message serverMessage, now time.Time) error {
	if !validAssignmentPrepare(message, now) {
		return errors.New("invalid assignment prepare")
	}
	c.assignmentMu.Lock()
	defer c.assignmentMu.Unlock()
	if c.assignment != nil {
		if !sameAssignment(c.assignment, message) {
			return errors.New("assignment conflict")
		}
		return c.send(c.assignmentStatus(c.assignment, c.assignment.State, "CAPABILITY_READY"))
	}
	assignment := assignmentFrom(message)
	media, err := newNativeMediaSession(c, assignment)
	if err != nil {
		return err
	}
	assignment.Media = media
	c.assignment = assignment
	c.thermalState = false
	return c.send(c.assignmentStatus(c.assignment, "ready", "CAPABILITY_READY"))
}

func (c *client) stopAssignment(message serverMessage) error {
	if !assignmentIDPattern.MatchString(message.AssignmentID) || message.ProgramEpoch < 1 ||
		message.FencingRevision < 1 || !reasonCodePattern.MatchString(message.ReasonCode) {
		return errors.New("invalid assignment stop")
	}
	c.assignmentMu.Lock()
	if c.assignment == nil {
		c.assignmentMu.Unlock()
		return errors.New("assignment not found")
	}
	if c.assignment.AssignmentID != message.AssignmentID || c.assignment.ProgramEpoch != message.ProgramEpoch ||
		c.assignment.FencingRevision != message.FencingRevision {
		c.assignmentMu.Unlock()
		return errors.New("stale assignment stop")
	}
	assignment := c.assignment
	assignment.State = "stopped"
	c.assignment = nil
	c.thermalState = false
	c.assignmentMu.Unlock()
	if assignment.Media != nil {
		assignment.Media.close()
	}
	return c.send(c.assignmentStatus(assignment, "stopped", "STOP_COMPLETE"))
}

func (c *client) expireAssignment(now time.Time) error {
	c.assignmentMu.Lock()
	assignment := c.assignment
	if assignment == nil || assignment.expiresAt.Load() > now.UnixMilli() {
		c.assignmentMu.Unlock()
		return nil
	}
	c.assignment = nil
	c.thermalState = false
	assignment.State = "failed"
	c.assignmentMu.Unlock()
	if assignment.Media != nil {
		assignment.Media.close()
	}
	return c.send(c.assignmentStatus(assignment, "failed", "LEASE_EXPIRED"))
}

func (c *client) heartbeatMessage() map[string]any {
	c.assignmentMu.Lock()
	defer c.assignmentMu.Unlock()
	if c.assignment == nil {
		return map[string]any{"version": 1, "type": "heartbeat", "assignmentId": "", "programEpoch": 0, "state": "idle", "observedAt": time.Now().UnixMilli()}
	}
	state := c.assignment.State
	return map[string]any{"version": 1, "type": "heartbeat", "assignmentId": c.assignment.AssignmentID,
		"programEpoch": c.assignment.ProgramEpoch, "state": state, "observedAt": time.Now().UnixMilli()}
}

func (c *client) reconcileLocalHealth(health string) error {
	if !oneOf(health, "healthy", "degraded", "draining") {
		health = "draining"
	}
	c.assignmentMu.Lock()
	assignment := c.assignment
	if assignment == nil {
		c.thermalState = false
		c.assignmentMu.Unlock()
		return nil
	}
	if health == "draining" {
		c.assignment = nil
		c.thermalState = false
		assignment.State = "failed"
		c.assignmentMu.Unlock()
		if assignment.Media != nil {
			assignment.Media.close()
		}
		return c.send(c.assignmentStatus(assignment, "failed", "THERMAL_LIMIT"))
	}
	if health == "degraded" && assignment.State == "running" && !c.thermalState {
		c.thermalState = true
		c.assignmentMu.Unlock()
		return c.transitionAssignment(assignment, "degraded", "THERMAL_PRESSURE")
	}
	if health == "healthy" && assignment.State == "degraded" && c.thermalState {
		c.thermalState = false
		c.assignmentMu.Unlock()
		return c.transitionAssignment(assignment, "running", "THERMAL_RECOVERED")
	}
	c.assignmentMu.Unlock()
	return nil
}
