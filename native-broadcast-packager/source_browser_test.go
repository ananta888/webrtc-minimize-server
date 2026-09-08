package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
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
	decoder   trustedSourceSink
	media     *sourceBrowserDecoded
	finished  <-chan struct{}
}

func (s *sourceBrowserSink) WriteEncoded(codec string, timestamp uint32, frame []byte) error {
	if s.closed.Load() || len(frame) < 1 {
		return errors.New("fixture sink closed")
	}
	if codec == "video/vp8" && len(frame) >= 10 && frame[0]&1 == 0 {
		s.keyframes.Add(1)
	}
	if s.decoder != nil {
		if err := s.decoder.WriteEncoded(codec, timestamp, frame); err != nil {
			return err
		}
	}
	s.frames.Add(1)
	s.ready()
	return nil
}
func (s *sourceBrowserSink) ready() {
	if s.frames.Load() >= 401 && (s.media == nil || s.media.frames.Load() >= 350) {
		select {
		case s.observed <- struct{}{}:
		default:
		}
	}
}
func (s *sourceBrowserSink) Close() {
	s.closed.Store(true)
	if s.decoder != nil {
		s.decoder.Close()
	}
}

// Actual decoded pixels/samples are inspected only here, not serialized.
type sourceBrowserDecoded struct {
	owner             *sourceBrowserSink
	frames            atomic.Int32
	closed            atomic.Bool
	changes, previous uint32
	lastChange        int32
	samples           int
	energy            float64
	lastEnergy        float64
	borrowed          []byte
}

func (s *sourceBrowserDecoded) WriteRGBA(width, height int, _ uint32, pixels []byte) error {
	if s.closed.Load() || width != 320 || height != 180 || len(pixels) != width*height*4 {
		return errors.New("fixture pixel scope")
	}
	color := binary.LittleEndian.Uint32(pixels[:4])
	if s.frames.Load() > 0 && color != s.previous {
		s.changes++
		s.lastChange = s.frames.Load() + 1
	}
	s.previous, s.borrowed = color, pixels
	s.frames.Add(1)
	s.owner.ready()
	return nil
}
func (s *sourceBrowserDecoded) WritePCM(rate, channels int, _ uint32, pcm []byte) error {
	if s.closed.Load() || rate != 48000 || channels != 2 || len(pcm)%4 != 0 {
		return errors.New("fixture PCM scope")
	}
	var energy float64
	for i := 0; i < len(pcm); i += 4 {
		value := float64(int16(binary.LittleEndian.Uint16(pcm[i:]))) / 32768
		energy += value * value
		s.samples++
	}
	s.energy += energy
	s.lastEnergy = energy / float64(len(pcm)/4)
	s.borrowed = pcm
	s.frames.Add(1)
	s.owner.ready()
	return nil
}
func (s *sourceBrowserDecoded) Close() { s.closed.Store(true) }

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
	if os.Getenv("TRUSTED_SOURCE_BROWSER_DECODE") == "1" {
		sink.media = &sourceBrowserDecoded{owner: sink}
	}
	budget := sourceDecodeTestBudget(t)
	c.trustedSourceSinkFactory = func(_ trustedsframe.SourceLease, receiver *trustedsframe.SourceReceiver) (trustedSourceSink, error) {
		if sink.media != nil {
			ffmpeg, lookupErr := exec.LookPath("ffmpeg")
			if lookupErr != nil {
				return nil, errors.New("fixture decoder unavailable")
			}
			if lease.Codec == "video/vp8" {
				decoder, decodeErr := newSourceVideoDecoder(sourceVideoDecodeConfig{budget: budget, ffmpegPath: ffmpeg, width: 320, height: 180,
					authorized: receiver.AliveNow, revoked: receiver.Done()}, sink.media)
				if decodeErr != nil {
					return nil, decodeErr
				}
				sink.decoder, sink.finished = decoder, decoder.finished
			} else {
				decoder, decodeErr := newSourceAudioDecoder(sourceAudioDecodeConfig{budget: budget, ffmpegPath: ffmpeg,
					authorized: receiver.AliveNow, revoked: receiver.Done()}, sink.media)
				if decodeErr != nil {
					return nil, decodeErr
				}
				sink.decoder, sink.finished = decoder, decoder.finished
			}
		}
		return sink, nil
	}
	t.Cleanup(func() {
		sink.Close()
		if sink.finished != nil {
			awaitSource(t, sink.finished)
		}
	})
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
			decoded := int32(0)
			if sink.media != nil {
				decoded = sink.media.frames.Load()
			}
			_ = emit(map[string]any{"fixture": "diagnostic", "frames": sink.frames.Load(), "keyframes": sink.keyframes.Load(), "decoded": decoded, "closed": sink.closed.Load(), "failure": failure})
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
			decoded := int32(0)
			if sink.finished != nil {
				awaitSource(t, sink.finished)
				decoded = sink.media.frames.Load()
				if !sink.media.closed.Load() || decoded < 350 {
					t.Fatal("decoded source cleanup failed")
				}
				for _, value := range sink.media.borrowed {
					if value != 0 {
						t.Fatal("borrowed media survived cleanup")
					}
				}
				if lease.Codec == "video/vp8" && (sink.media.changes < 100 || decoded-sink.media.lastChange > 10) {
					t.Fatal("decoded browser video froze")
				}
				if lease.Codec == "audio/opus" {
					rms := math.Sqrt(sink.media.energy / float64(sink.media.samples))
					if sink.media.samples < 48000 || rms < 0.005 || rms > 0.2 || sink.media.lastEnergy < 0.000025 {
						t.Fatal("decoded browser audio absent")
					}
				}
			}
			if !sink.closed.Load() || transport.receiver.AliveNow() || c.assignment.State != "running" {
				t.Fatal("browser source cleanup failed")
			}
			if emit(map[string]any{"fixture": "result", "frames": sink.frames.Load(), "keyframes": sink.keyframes.Load(), "decoded": decoded, "closed": true}) != nil {
				t.Fatal("fixture output failed")
			}
			return
		}
	}
}
