package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

type sourceAVClockProbe struct {
	mu                sync.Mutex
	onsets            [2][64]int64
	counts            [2]int
	high, initialized [2]bool
}

func (p *sourceAVClockProbe) observe(kind int, at int64, high bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.initialized[kind] && high && !p.high[kind] && p.counts[kind] < 64 {
		p.onsets[kind][p.counts[kind]] = at
		p.counts[kind]++
	}
	p.initialized[kind], p.high[kind] = true, high
}

func (p *sourceAVClockProbe) matched() (int, int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	matched, maximum, lastAudio := 0, int64(0), -1
	if p.counts[1] < 2 {
		return 0, 0
	}
	for i := 0; i < p.counts[0]; i++ {
		if p.onsets[0][i] < p.onsets[1][0] || p.onsets[0][i] > p.onsets[1][p.counts[1]-1] {
			continue
		}
		best, bestIndex := int64(1<<60), -1
		for j := 0; j < p.counts[1]; j++ {
			delta := p.onsets[0][i] - p.onsets[1][j]
			if delta < 0 {
				delta = -delta
			}
			if delta < best {
				best, bestIndex = delta, j
			}
		}
		// A decoded audio impulse cannot explain multiple video transitions.
		// Keep mismatches in the result instead of selecting only passing pairs.
		if bestIndex <= lastAudio {
			best = 1 << 60
		}
		lastAudio = bestIndex
		matched++
		maximum = max(maximum, best)
	}
	return matched, maximum
}

func TestSourceClockDecodedProbeRejectsMismatches(t *testing.T) {
	for _, mode := range []string{"aligned", "shifted", "duplicate"} {
		t.Run(mode, func(t *testing.T) {
			p := &sourceAVClockProbe{}
			for i := 0; i < 8; i++ {
				at := int64(i) * 30000
				p.observe(1, at-1, false)
				p.observe(1, at, true)
				if mode == "shifted" {
					at += 10000
				}
				p.observe(0, at-1, false)
				p.observe(0, at, true)
				if mode == "duplicate" {
					p.observe(0, at+10, false)
					p.observe(0, at+20, true)
				}
			}
			count, delta := p.matched()
			if count < 6 || (delta <= 7200) != (mode == "aligned") {
				t.Fatal("decoded comparison hid a timing mismatch")
			}
		})
	}
}

type sourceAVClockSink struct {
	*sourceMediaClock
	probe                    *sourceAVClockProbe
	decoder                  trustedSourceSink
	finished                 <-chan struct{}
	kind                     int
	encoded, decoded, mapped atomic.Int32
	closed                   atomic.Bool
}

func (s *sourceAVClockSink) WriteEncoded(codec string, timestamp uint32, frame []byte) error {
	if s.closed.Load() {
		return errors.New("AV fixture closed")
	}
	if err := s.decoder.WriteEncoded(codec, timestamp, frame); err != nil {
		return err
	}
	s.encoded.Add(1)
	return nil
}

func (s *sourceAVClockSink) WriteRGBA(width, height int, timestamp uint32, pixels []byte) error {
	if s.closed.Load() || width != 320 || height != 180 || len(pixels) != width*height*4 {
		return errors.New("AV fixture pixels")
	}
	s.decoded.Add(1)
	if at, ok := s.Map(timestamp); ok {
		s.mapped.Add(1)
		s.probe.observe(0, at, pixels[0] > 160 && pixels[2] < 50)
	}
	return nil
}

func (s *sourceAVClockSink) WritePCM(rate, channels int, timestamp uint32, pcm []byte) error {
	if s.closed.Load() || rate != 48000 || channels != 2 || len(pcm) == 0 || len(pcm)%4 != 0 {
		return errors.New("AV fixture PCM")
	}
	s.decoded.Add(1)
	if at, ok := s.Map(timestamp); ok {
		var energy float64
		for i := 0; i < len(pcm); i += 4 {
			value := float64(int16(binary.LittleEndian.Uint16(pcm[i:]))) / 32768
			energy += value * value
		}
		s.mapped.Add(1)
		s.probe.observe(1, at, energy/float64(len(pcm)/4) > 0.0004)
	}
	return nil
}

// Decoder output must not recursively call its own Close. Keep a separate
// terminal output facade; the transport remains owner of decoder shutdown.
type sourceAVDecodedOutput struct{ *sourceAVClockSink }

func (s sourceAVDecodedOutput) Close() { s.closed.Store(true) }

func (s *sourceAVClockSink) Close() {
	s.closed.Store(true)
	if s.decoder != nil {
		s.decoder.Close()
	}
}

func TestSourcePublisherAVClockInterop(t *testing.T) {
	if os.Getenv("TRUSTED_SOURCE_AV_CLOCK_INTEROP") != "1" {
		t.Skip("explicit synthetic paired-browser clock fixture only")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("paired clock fixture requires real decoding")
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
		Sources []struct {
			Codec         string `json:"codec"`
			PublicationID string `json:"publicationId"`
		} `json:"sources"`
	}
	if json.Unmarshal(awaitSource(t, input), &init) != nil || len(init.Sources) != 2 || init.Sources[0].Codec != "video/vp8" || init.Sources[1].Codec != "audio/opus" {
		t.Fatal("invalid paired source fixture")
	}
	c, base, now := trustedSourceFixture(t)
	c.api, err = createWebRTCAPI()
	if err != nil {
		t.Fatal(err)
	}
	group, err := newSourcePublisherClock(now, time.Now, 14400)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(group.Close)
	probe := &sourceAVClockProbe{}
	var leases [2]trustedsframe.SourceLease
	var sinks [2]*sourceAVClockSink
	for i := range leases {
		lease := base
		lease.Codec, lease.PublicationID = init.Sources[i].Codec, init.Sources[i].PublicationID
		lease.ExpiresAt = now.Add(4 * time.Second).UnixMilli()
		if i == 1 {
			lease.SourceLeaseID, lease.Consent.ConsentID, lease.Consent.SourceID = "sls_bbbbbbbbbbbbbbbb", "cns_bbbbbbbbbbbbbbbb", "src_bbbbbbbbbbbbbbbb"
			lease.Consent.SourceKind = "microphone"
		}
		leases[i] = lease
		clock, err := group.NewSource()
		if err != nil {
			t.Fatal(err)
		}
		sinks[i] = &sourceAVClockSink{sourceMediaClock: clock, probe: probe, kind: i}
	}
	c.trustedSourceSinkFactory = func(lease trustedsframe.SourceLease, receiver *trustedsframe.SourceReceiver) (trustedSourceSink, error) {
		index := 0
		if lease.Codec == "audio/opus" {
			index = 1
		}
		s := sinks[index]
		if s.decoder != nil {
			return nil, errors.New("duplicate paired fixture source")
		}
		output := sourceAVDecodedOutput{s}
		if index == 0 {
			d, err := newSourceVideoDecoder(sourceVideoDecodeConfig{ffmpegPath: ffmpeg, width: 320, height: 180, authorized: receiver.AliveNow, revoked: receiver.Done()}, output)
			if err != nil {
				return nil, err
			}
			s.decoder, s.finished = d, d.finished
		} else {
			d, err := newSourceAudioDecoder(sourceAudioDecodeConfig{ffmpegPath: ffmpeg, authorized: receiver.AliveNow, revoked: receiver.Done()}, output)
			if err != nil {
				return nil, err
			}
			s.decoder, s.finished = d, d.finished
		}
		return s, nil
	}
	t.Cleanup(func() {
		c.closeTrustedSources()
		for _, s := range sinks {
			s.Close()
			s.CloseSourceClock()
			if s.finished != nil {
				awaitSource(t, s.finished)
			}
		}
	})
	var output sync.Mutex
	emit := func(value any) error {
		output.Lock()
		defer output.Unlock()
		return json.NewEncoder(os.Stdout).Encode(value)
	}
	c.sendOverride = emit
	defer func() {
		if t.Failed() {
			states := make([]map[string]any, 2)
			for i, s := range sinks {
				s.mu.Lock()
				reports, closed := s.reports, s.sourceMediaClock.closed
				s.mu.Unlock()
				states[i] = map[string]any{"reports": reports, "clockClosed": closed, "encoded": s.encoded.Load(), "decoded": s.decoded.Load(), "mapped": s.mapped.Load(), "closed": s.closed.Load()}
			}
			matched, delta := probe.matched()
			_ = emit(map[string]any{"fixture": "diagnostic", "states": states, "matched": matched, "maxDeltaSamples": delta})
		}
	}()
	for _, lease := range leases {
		if _, err := c.prepareTrustedSource(sourceBytes(t, lease), now); err != nil {
			t.Fatal(err)
		}
	}
	if emit(map[string]any{"fixture": "leases", "leases": leases}) != nil {
		t.Fatal("paired fixture output")
	}
	renew := time.NewTicker(time.Second)
	defer renew.Stop()
	check := time.NewTicker(100 * time.Millisecond)
	defer check.Stop()
	deadline := time.NewTimer(25 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("paired source clock deadline")
		case <-renew.C:
			for i := range leases {
				l := &leases[i]
				l.Revision++
				l.IssuedAt = time.Now().UnixMilli()
				l.ExpiresAt = l.IssuedAt + 4000
				if _, err := c.prepareTrustedSource(sourceBytes(t, *l), time.Now()); err != nil {
					t.Fatal("paired renewal failed")
				}
				if emit(map[string]any{"fixture": "lease", "lease": l}) != nil {
					t.Fatal("paired renewal output")
				}
			}
		case raw, open := <-input:
			if !open {
				t.Fatal("paired publisher ended early")
			}
			var fields map[string]json.RawMessage
			if json.Unmarshal(raw, &fields) != nil || string(fields["type"]) != `"trusted-source-publisher-signal"` {
				t.Fatal("paired signal shape")
			}
			fields["type"] = json.RawMessage(`"trusted-source-peer-signal"`)
			fields["publisherPeerId"], _ = json.Marshal(base.PublisherPeerID)
			raw, _ = json.Marshal(fields)
			message, err := decodeServerMessage(raw)
			if err != nil || message.SourceSignal == nil || c.handleTrustedSourceSignal(message.SourceSignal) != nil {
				t.Fatal("paired signal dispatch")
			}
		case <-check.C:
			matched, maximum := probe.matched()
			if sinks[0].encoded.Load() < 401 || sinks[1].encoded.Load() < 401 || matched < 6 {
				continue
			}
			if maximum > 7200 {
				t.Fatalf("paired decoded A/V delta %.1f ms", float64(maximum)/48)
			}
			c.sourcesMu.Lock()
			transports := []*trustedSourceTransport{c.trustedSources[leases[0].SourceLeaseID].transport, c.trustedSources[leases[1].SourceLeaseID].transport}
			c.sourcesMu.Unlock()
			c.closeTrustedSources()
			for i, s := range sinks {
				awaitSource(t, transports[i].done)
				awaitSource(t, s.finished)
				if _, ok := s.Map(0); ok || !s.closed.Load() || s.mapped.Load() < 100 {
					t.Fatal("paired clock revoke or media scope failed")
				}
			}
			if c.assignment.State != "running" || group.sources != 0 {
				t.Fatal("paired cleanup damaged parent")
			}
			if emit(map[string]any{"fixture": "result", "matched": matched, "maxDeltaSamples": maximum, "closed": true}) != nil {
				t.Fatal("paired result output")
			}
			return
		}
	}
}
