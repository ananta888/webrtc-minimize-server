package main

import (
	"encoding/json"
	"testing"
	"time"
)

func assignmentMessage(now time.Time) serverMessage {
	return serverMessage{
		Version: 1, Type: "assignment-prepare", AssignmentID: "asn_0123456789abcdef",
		RoomID: "room-alpha", ProgramID: "prg_0123456789abcdef", ProgramEpoch: 2,
		LeaseID: "lea_0123456789abcdef", FencingRevision: 3, ResourceRef: "res_0123456789abcdef",
		ExpiresAt: now.Add(time.Minute).UnixMilli(),
		Profile: assignmentProfile{
			ProfileID: "h264-aac-720p-v1", MaximumQueueFrames: 60, KeyframeIntervalSeconds: 2,
			Renditions: []assignmentRendition{{
				ID: "low", Width: 640, Height: 360, FramesPerSecond: 15,
				VideoBitsPerSecond: 500000, AudioBitsPerSecond: 64000,
			}},
		},
	}
}

func TestAssignmentValidationAndFencing(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	message := assignmentMessage(now)
	if !validAssignmentPrepare(message, now) {
		t.Fatal("valid assignment rejected")
	}
	assignment := assignmentFrom(message)
	if assignment.State != "ready" || !sameAssignment(assignment, message) {
		t.Fatal("assignment was not normalized deterministically")
	}
	stale := message
	stale.FencingRevision--
	if sameAssignment(assignment, stale) {
		t.Fatal("stale fence treated as idempotent")
	}
	invalid := message
	invalid.Profile.Renditions = append(invalid.Profile.Renditions, invalid.Profile.Renditions[0])
	if validAssignmentPrepare(invalid, now) {
		t.Fatal("duplicate rendition accepted")
	}
}

func TestControlMessagesAreClosedPerType(t *testing.T) {
	now := time.Now()
	message := assignmentMessage(now)
	raw, err := json.Marshal(map[string]any{
		"version": message.Version, "type": message.Type, "assignmentId": message.AssignmentID,
		"roomId": message.RoomID, "programId": message.ProgramID, "programEpoch": message.ProgramEpoch,
		"leaseId": message.LeaseID, "fencingRevision": message.FencingRevision,
		"resourceRef": message.ResourceRef, "profile": message.Profile, "expiresAt": message.ExpiresAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeServerMessage(raw)
	if err != nil || !validAssignmentPrepare(decoded, now) {
		t.Fatalf("valid closed message rejected: %v", err)
	}
	var expanded map[string]any
	_ = json.Unmarshal(raw, &expanded)
	expanded["decryptKey"] = "forbidden"
	expandedRaw, _ := json.Marshal(expanded)
	if _, err = decodeServerMessage(expandedRaw); err == nil {
		t.Fatal("unknown decrypt field accepted")
	}
}

func TestPreparedAssignmentHeartbeatDoesNotClaimMediaStarted(t *testing.T) {
	message := assignmentMessage(time.Now())
	packager := &client{assignment: assignmentFrom(message)}
	heartbeat := packager.heartbeatMessage()
	if heartbeat["state"] != "ready" || heartbeat["assignmentId"] != message.AssignmentID {
		t.Fatalf("prepared assignment heartbeat widened its state: %#v", heartbeat)
	}
}
