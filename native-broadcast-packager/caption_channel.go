package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"
)

const (
	nativeCaptionChannelLabel = "broadcast-captions-v1"
	nativeCaptionFilename     = "captions_live.vtt"
	maximumCaptionMessageSize = 70 * 1024
	maximumCaptionBodySize    = 64 * 1024
)

var captionLanguagePattern = regexp.MustCompile(`^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$`)

type nativeCaptionMessage struct {
	Version               int    `json:"version"`
	Type                  string `json:"type"`
	AssignmentID          string `json:"assignmentId"`
	ProgramEpoch          int    `json:"programEpoch"`
	FencingRevision       int    `json:"fencingRevision"`
	Operation             string `json:"operation"`
	Language              string `json:"language,omitempty"`
	MediaSequence         *int64 `json:"mediaSequence,omitempty"`
	DiscontinuitySequence int64  `json:"discontinuitySequence"`
	StartsAtMs            *int64 `json:"startsAtMs,omitempty"`
	EndsAtMs              *int64 `json:"endsAtMs,omitempty"`
	CueCount              *int   `json:"cueCount,omitempty"`
	Body                  string `json:"body,omitempty"`
}

func decodeNativeCaption(raw []byte, assignment *packagerAssignment) (*nativeCaptionMessage, error) {
	if len(raw) == 0 || len(raw) > maximumCaptionMessageSize || assignment == nil || !utf8.Valid(raw) {
		return nil, errors.New("invalid native caption message")
	}
	var message nativeCaptionMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&message); err != nil {
		return nil, errors.New("invalid native caption message")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("invalid native caption message")
	}
	if message.Version != 1 || message.Type != "caption-segment" ||
		message.AssignmentID != assignment.AssignmentID || message.ProgramEpoch != assignment.ProgramEpoch ||
		message.FencingRevision != assignment.FencingRevision || message.DiscontinuitySequence < 0 ||
		message.DiscontinuitySequence > 1_000_000 {
		return nil, errors.New("stale native caption message")
	}
	keys := []string{"version", "type", "assignmentId", "programEpoch", "fencingRevision", "operation", "discontinuitySequence"}
	if message.Operation == "update" {
		keys = append(keys, "language", "mediaSequence", "startsAtMs", "endsAtMs", "cueCount", "body")
	}
	// encoding/json otherwise silently accepts duplicate keys and null scalars.
	exact, ok := sourceProgramExactObject(raw, keys...)
	if !ok {
		return nil, errors.New("invalid native caption shape")
	}
	for _, value := range exact {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errors.New("invalid native caption value")
		}
	}
	if message.Operation == "revoke" {
		return &message, nil
	}
	if message.Operation != "update" || !captionLanguagePattern.MatchString(message.Language) ||
		message.MediaSequence == nil || *message.MediaSequence < 0 || *message.MediaSequence > 10_000_000 ||
		message.StartsAtMs == nil || message.EndsAtMs == nil || *message.StartsAtMs < 0 ||
		*message.EndsAtMs < *message.StartsAtMs || *message.EndsAtMs > *message.StartsAtMs+60_000 ||
		message.CueCount == nil || *message.CueCount < 1 || *message.CueCount > 32 ||
		len(message.Body) == 0 || len(message.Body) > maximumCaptionBodySize ||
		!strings.HasPrefix(message.Body, "WEBVTT\n\n") || strings.ContainsRune(message.Body, '\x00') {
		return nil, errors.New("invalid native caption update")
	}
	return &message, nil
}

func (media *nativeMediaSession) attachCaptionChannel(channel *webrtc.DataChannel) {
	if channel == nil || channel.Label() != nativeCaptionChannelLabel || !channel.Ordered() ||
		media.closed.Load() || media.captionSet.Swap(true) {
		if channel != nil {
			_ = channel.Close()
		}
		return
	}
	channel.OnMessage(func(value webrtc.DataChannelMessage) {
		if value.IsString && !media.closed.Load() {
			media.acceptCaptionMessage(value.Data)
		}
	})
}

func (media *nativeMediaSession) acceptCaptionMessage(raw []byte) {
	if media.closed.Load() || time.Now().UnixMilli() >= media.assignment.expiresAt.Load() {
		return
	}
	message, err := decodeNativeCaption(raw, media.assignment)
	if err != nil {
		return
	}
	media.captionMu.Lock()
	current := media.caption
	if message.Operation == "update" && media.captionHasUpdate && *message.MediaSequence <= media.captionSequence {
		media.captionMu.Unlock()
		return
	}
	if current != nil && message.DiscontinuitySequence < current.DiscontinuitySequence {
		media.captionMu.Unlock()
		return
	}
	media.caption = message
	if message.Operation == "update" {
		media.captionHasUpdate = true
		media.captionSequence = *message.MediaSequence
	}
	media.captionMu.Unlock()
	media.flushCaptionOutput()
}

func (media *nativeMediaSession) flushCaptionOutput() {
	media.pipelineMu.Lock()
	pipeline := media.pipeline
	media.pipelineMu.Unlock()
	if pipeline == nil || media.closed.Load() {
		return
	}
	media.captionMu.Lock()
	defer media.captionMu.Unlock()
	if media.caption == nil {
		return
	}
	filename := filepath.Join(pipeline.output, nativeCaptionFilename)
	if media.caption.Operation == "revoke" {
		_ = os.Remove(filename)
		return
	}
	temporary, err := os.CreateTemp(pipeline.output, ".captions-live-")
	if err != nil {
		return
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0o600); err == nil {
		_, err = temporary.WriteString(media.caption.Body)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		_ = os.Rename(name, filename)
	}
}
