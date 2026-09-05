package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const maximumPendingNativeCandidates = 128

type nativeMediaSession struct {
	client            *client
	assignment        *packagerAssignment
	pc                *webrtc.PeerConnection
	signalMu          sync.Mutex
	pending           []webrtc.ICECandidateInit
	closed            atomic.Bool
	pipelineMu        sync.Mutex
	videoCodec        webrtc.RTPCodecParameters
	audioCodec        webrtc.RTPCodecParameters
	pipeline          *transcodePipeline
	fallbackAttempted bool
	startTimer        *time.Timer
	captionMu         sync.Mutex
	caption           *nativeCaptionMessage
	captionSet        atomic.Bool
	bytes             atomic.Uint64
	packets           atomic.Uint64
}

func newNativeMediaSession(client *client, assignment *packagerAssignment) (*nativeMediaSession, error) {
	if client == nil || client.api == nil || assignment == nil {
		return nil, errors.New("native media configuration unavailable")
	}
	configuration := webrtc.Configuration{ICETransportPolicy: client.cfg.iceTransportPolicy}
	if len(assignment.ICEServers) > 0 {
		for _, server := range assignment.ICEServers {
			iceServer := webrtc.ICEServer{
				URLs: append([]string(nil), server.URLs...), Username: server.Username, Credential: server.Credential,
			}
			if server.CredentialType == "password" {
				iceServer.CredentialType = webrtc.ICECredentialTypePassword
			}
			configuration.ICEServers = append(configuration.ICEServers, iceServer)
		}
	} else if len(client.cfg.stunURLs) > 0 {
		configuration.ICEServers = []webrtc.ICEServer{{URLs: append([]string(nil), client.cfg.stunURLs...)}}
	}
	pc, err := client.api.NewPeerConnection(configuration)
	if err != nil {
		return nil, fmt.Errorf("create native media connection: %w", err)
	}
	media := &nativeMediaSession{client: client, assignment: assignment, pc: pc}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		value := any(nil)
		if candidate != nil {
			value = candidate.ToJSON()
		}
		_ = client.send(media.signalMessage("candidate", value))
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			_ = client.transitionAssignment(assignment, "starting", "MEDIA_CONNECTED")
		case webrtc.PeerConnectionStateDisconnected:
			_ = client.transitionAssignment(assignment, "degraded", "MEDIA_DISCONNECTED")
		case webrtc.PeerConnectionStateFailed:
			_ = client.transitionAssignment(assignment, "failed", "MEDIA_CONNECTION_FAILED")
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if err := media.registerTrack(track); err != nil {
			_ = client.transitionAssignment(assignment, "failed", "UNSUPPORTED_INGRESS_CODEC")
			return
		}
		go media.readTrack(track)
	})
	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		media.attachCaptionChannel(channel)
	})
	return media, nil
}

func (media *nativeMediaSession) signalMessage(kind string, payload any) map[string]any {
	message := map[string]any{
		"version": 1, "type": "assignment-signal", "assignmentId": media.assignment.AssignmentID,
		"programEpoch": media.assignment.ProgramEpoch, "fencingRevision": media.assignment.FencingRevision,
	}
	message[kind] = payload
	return message
}

func (media *nativeMediaSession) handle(message serverMessage) error {
	media.signalMu.Lock()
	defer media.signalMu.Unlock()
	if media.closed.Load() || message.AssignmentID != media.assignment.AssignmentID ||
		message.PublisherPeerID != media.assignment.PublisherPeerID ||
		message.ProgramEpoch != media.assignment.ProgramEpoch ||
		message.FencingRevision != media.assignment.FencingRevision || time.Now().UnixMilli() >= media.assignment.expiresAt.Load() {
		return errors.New("stale assignment media signal")
	}
	if message.Description != nil {
		if message.Description.Type != webrtc.SDPTypeOffer || len(message.Description.SDP) > 80000 || media.pc.SignalingState() != webrtc.SignalingStateStable {
			return errors.New("invalid assignment media offer")
		}
		if err := media.pc.SetRemoteDescription(*message.Description); err != nil {
			return fmt.Errorf("apply assignment media offer: %w", err)
		}
		for _, candidate := range media.pending {
			if err := media.pc.AddICECandidate(candidate); err != nil {
				return fmt.Errorf("apply pending assignment candidate: %w", err)
			}
		}
		media.pending = nil
		answer, err := media.pc.CreateAnswer(nil)
		if err != nil {
			return fmt.Errorf("create assignment media answer: %w", err)
		}
		if err = media.pc.SetLocalDescription(answer); err != nil {
			return fmt.Errorf("apply assignment media answer: %w", err)
		}
		return media.client.send(media.signalMessage("description", media.pc.LocalDescription()))
	}
	candidate, err := decodeNativeCandidate(message.Candidate)
	if err != nil {
		return err
	}
	if media.pc.RemoteDescription() == nil {
		if len(media.pending) >= maximumPendingNativeCandidates {
			return errors.New("assignment candidate queue full")
		}
		media.pending = append(media.pending, candidate)
		return nil
	}
	if err = media.pc.AddICECandidate(candidate); err != nil {
		return fmt.Errorf("apply assignment candidate: %w", err)
	}
	return nil
}

func decodeNativeCandidate(raw json.RawMessage) (webrtc.ICECandidateInit, error) {
	if len(raw) == 0 || len(raw) > 4096+512 {
		return webrtc.ICECandidateInit{}, errors.New("invalid assignment candidate")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return webrtc.ICECandidateInit{}, nil
	}
	var candidate webrtc.ICECandidateInit
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&candidate); err != nil || len(candidate.Candidate) > 4096 {
		return webrtc.ICECandidateInit{}, errors.New("invalid assignment candidate")
	}
	return candidate, nil
}

func (media *nativeMediaSession) readTrack(track *webrtc.TrackRemote) {
	if track.Kind() != webrtc.RTPCodecTypeAudio && track.Kind() != webrtc.RTPCodecTypeVideo {
		return
	}
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		media.packets.Add(1)
		media.bytes.Add(uint64(packet.MarshalSize()))
		media.pipelineMu.Lock()
		pipeline := media.pipeline
		media.pipelineMu.Unlock()
		if pipeline != nil {
			if err = pipeline.write(track.Kind(), packet); err != nil {
				_ = media.client.transitionAssignment(media.assignment, "failed", "TRANSCODE_INPUT_FAILED")
				return
			}
		}
	}
}

func (media *nativeMediaSession) registerTrack(track *webrtc.TrackRemote) error {
	codec := track.Codec()
	if track.Kind() != webrtc.RTPCodecTypeVideo && track.Kind() != webrtc.RTPCodecTypeAudio {
		return errors.New("unsupported native media kind")
	}
	if track.Kind() == webrtc.RTPCodecTypeVideo && !strings.EqualFold(codec.MimeType, webrtc.MimeTypeVP8) {
		return errors.New("unsupported native video codec")
	}
	if track.Kind() == webrtc.RTPCodecTypeAudio && !strings.EqualFold(codec.MimeType, webrtc.MimeTypeOpus) {
		return errors.New("unsupported native audio codec")
	}
	media.pipelineMu.Lock()
	defer media.pipelineMu.Unlock()
	if media.closed.Load() {
		return errors.New("native media closed")
	}
	if track.Kind() == webrtc.RTPCodecTypeVideo {
		if media.videoCodec.MimeType != "" {
			return errors.New("duplicate native video track")
		}
		media.videoCodec = codec
	} else {
		if media.audioCodec.MimeType != "" {
			return errors.New("duplicate native audio track")
		}
		media.audioCodec = codec
	}
	if media.startTimer == nil {
		media.startTimer = time.AfterFunc(750*time.Millisecond, media.startTranscode)
	}
	return nil
}

func (media *nativeMediaSession) startTranscode() {
	media.startTranscodeWithEncoder(selectedVideoEncoder(media.assignment.Profile), "OUTPUT_READY")
}

func (media *nativeMediaSession) startTranscodeWithEncoder(encoder, readyReason string) {
	media.pipelineMu.Lock()
	if media.closed.Load() || media.pipeline != nil {
		media.pipelineMu.Unlock()
		return
	}
	videoCodec := media.videoCodec
	audioCodec := media.audioCodec
	media.pipelineMu.Unlock()
	pipelineReady := make(chan *transcodePipeline, 1)
	pipeline, err := startTranscodePipeline(media.client.cfg, media.assignment, videoCodec, audioCodec, encoder, func() {
		_ = media.client.transitionAssignment(media.assignment, "running", readyReason)
	}, func() {
		media.handleTranscodeFailure(<-pipelineReady)
	})
	if err != nil {
		_ = media.client.transitionAssignment(media.assignment, "failed", "TRANSCODE_START_FAILED")
		return
	}
	media.pipelineMu.Lock()
	if media.closed.Load() {
		media.pipelineMu.Unlock()
		pipeline.close()
		return
	}
	media.pipeline = pipeline
	media.pipelineMu.Unlock()
	pipelineReady <- pipeline
	media.flushCaptionOutput()
}

func (media *nativeMediaSession) handleTranscodeFailure(failed *transcodePipeline) {
	media.pipelineMu.Lock()
	if media.closed.Load() || media.pipeline != failed {
		media.pipelineMu.Unlock()
		return
	}
	media.pipeline = nil
	fallback := media.assignment.Profile.SoftwareFallback
	useFallback := failed.encoder != "libx264" && fallback == "libx264" && !media.fallbackAttempted
	if useFallback {
		media.fallbackAttempted = true
	}
	media.pipelineMu.Unlock()
	failed.close()
	if !useFallback {
		_ = media.client.transitionAssignment(media.assignment, "failed", "TRANSCODE_FAILED")
		return
	}
	_ = media.client.transitionAssignment(media.assignment, "degraded", "HARDWARE_ENCODER_FALLBACK")
	media.startTranscodeWithEncoder(fallback, "SOFTWARE_FALLBACK_READY")
}

func (media *nativeMediaSession) close() {
	media.signalMu.Lock()
	if media.closed.Swap(true) {
		media.signalMu.Unlock()
		return
	}
	media.pending = nil
	_ = media.pc.Close()
	media.signalMu.Unlock()
	media.pipelineMu.Lock()
	if media.startTimer != nil {
		media.startTimer.Stop()
	}
	pipeline := media.pipeline
	media.pipeline = nil
	media.pipelineMu.Unlock()
	if pipeline != nil {
		pipeline.close()
	}
}

func (c *client) handleAssignmentSignal(message serverMessage) error {
	c.assignmentMu.Lock()
	assignment := c.assignment
	c.assignmentMu.Unlock()
	if assignment == nil || assignment.Media == nil {
		return errors.New("assignment media unavailable")
	}
	return assignment.Media.handle(message)
}

func (c *client) transitionAssignment(assignment *packagerAssignment, state, reasonCode string) error {
	c.assignmentMu.Lock()
	if c.assignment != assignment || assignment == nil {
		c.assignmentMu.Unlock()
		return nil
	}
	current := assignment.State
	if current == state {
		c.assignmentMu.Unlock()
		return nil
	}
	if state == "running" && current == "ready" {
		assignment.State = "starting"
		c.assignmentMu.Unlock()
		if err := c.send(c.assignmentStatus(assignment, "starting", "MEDIA_CONNECTED")); err != nil {
			return err
		}
		return c.transitionAssignment(assignment, state, reasonCode)
	}
	allowed := map[string]map[string]bool{
		"ready":    {"starting": true, "failed": true},
		"starting": {"running": true, "degraded": true, "failed": true},
		"running":  {"degraded": true, "failed": true},
		"degraded": {"running": true, "failed": true},
	}
	if !allowed[current][state] {
		c.assignmentMu.Unlock()
		return nil
	}
	assignment.State = state
	c.assignmentMu.Unlock()
	return c.send(c.assignmentStatus(assignment, state, reasonCode))
}

func (c *client) closeAssignmentMedia() {
	c.assignmentMu.Lock()
	assignment := c.assignment
	c.assignment = nil
	c.thermalState = false
	c.assignmentMu.Unlock()
	if assignment != nil && assignment.Media != nil {
		assignment.Media.close()
	}
}
