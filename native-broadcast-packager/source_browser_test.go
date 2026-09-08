package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

// Explicitly synthetic headless policy fixture. No production enrollment,
// capture device, source-approval API or plaintext output endpoint is added.
type sourceBrowserSink struct {
	frames    atomic.Int32
	keyframes atomic.Int32
	closed    atomic.Bool
	observed  chan struct{}
}

func (s *sourceBrowserSink) WriteEncoded(codec string, _ uint32, frame []byte) error {
	if s.closed.Load() || len(frame) < 1 {
		return errors.New("fixture sink closed")
	}
	if codec == "video/vp8" && len(frame) >= 10 && frame[0]&1 == 0 {
		s.keyframes.Add(1)
	}
	if s.frames.Add(1) == 401 {
		s.observed <- struct{}{}
	}
	return nil
}
func (s *sourceBrowserSink) Close() { s.closed.Store(true) }

func TestSourcePublisherBrowserInterop(t *testing.T) {
	if os.Getenv("TRUSTED_SOURCE_BROWSER_INTEROP") != "1" {
		t.Skip("explicit synthetic browser source fixture only")
	}
	input := make(chan []byte, 32)
	go func() {
		defer close(input)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 32*1024)
		for scanner.Scan() {
			input <- append([]byte(nil), scanner.Bytes()...)
		}
	}()
	var init struct {
		Codec         string `json:"codec"`
		PublicationID string `json:"publicationId"`
	}
	if json.Unmarshal(awaitSource(t, input), &init) != nil || !oneOf(init.Codec, "video/vp8", "audio/opus") {
		t.Fatal("invalid synthetic source")
	}
	c, lease, now := trustedSourceFixture(t)
	lease.Codec, lease.PublicationID = init.Codec, init.PublicationID
	lease.ExpiresAt = now.Add(4 * time.Second).UnixMilli()
	if init.Codec == "audio/opus" {
		lease.Consent.SourceKind = "microphone"
	}
	var err error
	c.api, err = createWebRTCAPI()
	if err != nil {
		t.Fatal(err)
	}
	sink := &sourceBrowserSink{observed: make(chan struct{}, 1)}
	c.trustedSourceSinkFactory = func(trustedsframe.SourceLease) (trustedSourceSink, error) { return sink, nil }
	var output sync.Mutex
	var transport *trustedSourceTransport
	emit := func(value any) error {
		output.Lock()
		defer output.Unlock()
		return json.NewEncoder(os.Stdout).Encode(value)
	}
	defer func() {
		if t.Failed() {
			var failure int32
			if transport != nil {
				failure = transport.failure.Load()
			}
			_ = emit(map[string]any{"fixture": "diagnostic", "frames": sink.frames.Load(), "keyframes": sink.keyframes.Load(), "closed": sink.closed.Load(), "failure": failure})
		}
	}()
	c.sendOverride = emit
	if _, err = c.prepareTrustedSource(sourceBytes(t, lease), now); err != nil {
		t.Fatal(err)
	}
	if emit(map[string]any{"fixture": "lease", "lease": lease}) != nil {
		t.Fatal("fixture output failed")
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	deadline := time.NewTimer(25 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("real browser source RTP deadline")
		case <-ticker.C:
			lease.Revision++
			lease.IssuedAt = time.Now().UnixMilli()
			lease.ExpiresAt = lease.IssuedAt + 4000
			if _, err = c.prepareTrustedSource(sourceBytes(t, lease), time.Now()); err != nil {
				t.Fatal("browser source renewal failed")
			}
			if emit(map[string]any{"fixture": "lease", "lease": lease}) != nil {
				t.Fatal("fixture output failed")
			}
		case raw, open := <-input:
			if !open {
				t.Fatal("browser control ended before media")
			}
			// Explicit metadata-only stand-in for the separately tested server broker.
			var fields map[string]json.RawMessage
			if json.Unmarshal(raw, &fields) != nil || string(fields["type"]) != `"trusted-source-publisher-signal"` {
				t.Fatal("invalid publisher control")
			}
			fields["type"] = json.RawMessage(`"trusted-source-peer-signal"`)
			fields["publisherPeerId"], _ = json.Marshal(lease.PublisherPeerID)
			forwarded, _ := json.Marshal(fields)
			message, parseErr := decodeServerMessage(forwarded)
			if parseErr != nil || message.SourceSignal == nil {
				t.Fatal("invalid native source signal")
			}
			if err = c.handleTrustedSourceSignal(message.SourceSignal); err != nil {
				t.Fatal("source signal dispatch failed")
			}
			c.sourcesMu.Lock()
			if source := c.trustedSources[lease.SourceLeaseID]; source != nil {
				transport = source.transport
			}
			c.sourcesMu.Unlock()
		case <-sink.observed:
			if lease.Codec == "video/vp8" && sink.keyframes.Load() < 1 {
				t.Fatal("no authenticated VP8 keyframe")
			}
			c.sourcesMu.Lock()
			transport := c.trustedSources[lease.SourceLeaseID].transport
			c.sourcesMu.Unlock()
			c.closeTrustedSources()
			awaitSource(t, transport.done)
			if !sink.closed.Load() || transport.receiver.AliveNow() || c.assignment.State != "running" {
				t.Fatal("browser source cleanup failed")
			}
			if emit(map[string]any{"fixture": "result", "frames": sink.frames.Load(), "keyframes": sink.keyframes.Load(), "closed": true}) != nil {
				t.Fatal("fixture output failed")
			}
			return
		}
	}
}
