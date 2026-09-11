package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func captionJSON(t *testing.T, assignment *packagerAssignment, values map[string]any) []byte {
	t.Helper()
	message := map[string]any{
		"version": 1, "type": "caption-segment", "assignmentId": assignment.AssignmentID,
		"programEpoch": assignment.ProgramEpoch, "fencingRevision": assignment.FencingRevision,
		"operation": "update", "language": "de-DE", "mediaSequence": 3,
		"discontinuitySequence": 1, "startsAtMs": 1200, "endsAtMs": 2700,
		"cueCount": 1, "body": "WEBVTT\n\ncc-1\n00:00:01.200 --> 00:00:02.700\nHallo\n",
	}
	for key, value := range values {
		if value == nil {
			delete(message, key)
		} else {
			message[key] = value
		}
	}
	raw, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestNativeCaptionContractIsAssignmentBoundAndClosed(t *testing.T) {
	assignment := assignmentFrom(assignmentMessage(time.Now()))
	if _, err := decodeNativeCaption(captionJSON(t, assignment, nil), assignment); err != nil {
		t.Fatal(err)
	}
	for name, values := range map[string]map[string]any{
		"wrong epoch":     {"programEpoch": assignment.ProgramEpoch + 1},
		"unknown field":   {"transcript": "must-not-pass"},
		"missing field":   {"cueCount": nil},
		"invalid payload": {"body": "not-webvtt"},
		"oversize":        {"body": "WEBVTT\n\n" + strings.Repeat("x", maximumCaptionBodySize)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeNativeCaption(captionJSON(t, assignment, values), assignment); err == nil {
				t.Fatal("invalid caption message accepted")
			}
		})
	}
	revoke := captionJSON(t, assignment, map[string]any{
		"operation": "revoke", "language": nil, "mediaSequence": nil,
		"startsAtMs": nil, "endsAtMs": nil, "cueCount": nil, "body": nil,
	})
	if message, err := decodeNativeCaption(revoke, assignment); err != nil || message.Operation != "revoke" {
		t.Fatalf("valid revoke rejected: %v", err)
	}
}

func TestNativeCaptionOutputIsAtomicBoundedAndRevocable(t *testing.T) {
	assignment := assignmentFrom(assignmentMessage(time.Now()))
	output := t.TempDir()
	media := &nativeMediaSession{
		assignment: assignment,
		pipeline:   &transcodePipeline{output: output},
	}
	first := captionJSON(t, assignment, nil)
	media.acceptCaptionMessage(first)
	filename := filepath.Join(output, nativeCaptionFilename)
	value, err := os.ReadFile(filename)
	if err != nil || !strings.Contains(string(value), "Hallo") {
		t.Fatalf("caption output unavailable: %v", err)
	}
	media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{
		"mediaSequence": 2, "body": "WEBVTT\n\nolder\n",
	}))
	value, _ = os.ReadFile(filename)
	if !strings.Contains(string(value), "Hallo") {
		t.Fatal("older caption sequence replaced current output")
	}
	media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{
		"operation": "revoke", "language": nil, "mediaSequence": nil,
		"discontinuitySequence": 2, "startsAtMs": nil, "endsAtMs": nil,
		"cueCount": nil, "body": nil,
	}))
	if _, err = os.Stat(filename); !os.IsNotExist(err) {
		t.Fatal("caption output survived revoke")
	}
}

func TestNativeCaptionRevokeRetainsSequenceBarrier(t *testing.T) {
	assignment := assignmentFrom(assignmentMessage(time.Now()))
	output := t.TempDir()
	media := &nativeMediaSession{assignment: assignment, pipeline: &transcodePipeline{output: output}}
	media.acceptCaptionMessage(captionJSON(t, assignment, nil))
	media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{
		"operation": "revoke", "language": nil, "mediaSequence": nil,
		"startsAtMs": nil, "endsAtMs": nil, "cueCount": nil, "body": nil,
	}))
	filename := filepath.Join(output, nativeCaptionFilename)
	for _, discontinuity := range []int{1, 2} {
		media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{"discontinuitySequence": discontinuity}))
		if _, err := os.Stat(filename); !os.IsNotExist(err) {
			t.Fatal("pre-revoke sequence revived caption output")
		}
	}
	media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{"mediaSequence": 4}))
	if _, err := os.Stat(filename); err != nil {
		t.Fatal("fresh higher sequence in current generation must remain usable")
	}
}

func TestNativeCaptionRejectsDuplicateAndNullFields(t *testing.T) {
	assignment := assignmentFrom(assignmentMessage(time.Now()))
	valid := string(captionJSON(t, assignment, nil))
	for _, raw := range []string{
		strings.Replace(valid, `"discontinuitySequence":1`, `"discontinuitySequence":null`, 1),
		strings.Replace(valid, `"discontinuitySequence":1`, `"discontinuitySequence":1,"discontinuitySequence":1`, 1),
		strings.Replace(valid, `"body":`, `"Body":"bad","body":`, 1),
	} {
		if _, err := decodeNativeCaption([]byte(raw), assignment); err == nil {
			t.Fatal("ambiguous caption envelope accepted")
		}
	}
}

func TestNativeCaptionConcurrentUpdatesCannotResetRevokeHighwater(t *testing.T) {
	assignment := assignmentFrom(assignmentMessage(time.Now()))
	output := t.TempDir()
	media := &nativeMediaSession{assignment: assignment, pipeline: &transcodePipeline{output: output}}
	var group sync.WaitGroup
	for n := 0; n < 32; n++ {
		raw := captionJSON(t, assignment, map[string]any{"mediaSequence": n})
		group.Add(1)
		go func() { defer group.Done(); media.acceptCaptionMessage(raw) }()
	}
	group.Wait()
	media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{
		"operation": "revoke", "language": nil, "mediaSequence": nil, "discontinuitySequence": 2,
		"startsAtMs": nil, "endsAtMs": nil, "cueCount": nil, "body": nil,
	}))
	for n := 0; n < 32; n++ {
		media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{"mediaSequence": n, "discontinuitySequence": 2}))
	}
	if _, err := os.Stat(filepath.Join(output, nativeCaptionFilename)); !os.IsNotExist(err) {
		t.Fatal("replay after concurrent updates recreated revoked captions")
	}
	media.acceptCaptionMessage(captionJSON(t, assignment, map[string]any{"mediaSequence": 32, "discontinuitySequence": 2}))
	if _, err := os.Stat(filepath.Join(output, nativeCaptionFilename)); err != nil {
		t.Fatal("fresh caption cannot recover after concurrent updates")
	}
}
