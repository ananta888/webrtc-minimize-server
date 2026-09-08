package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4/pkg/media/oggreader"
)

type decodedAudioFixture struct {
	mu        sync.Mutex
	closed    bool
	samples   int
	energy    float64
	spans     []sourceAudioSpan
	borrowed  []byte
	crossings int
	previous  int16
}

func (s *decodedAudioFixture) WritePCM(rate, channels int, timestamp uint32, pcm []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || rate != 48000 || channels != 2 || len(pcm)%4 != 0 || len(pcm) == 0 || len(pcm) > 5760*4 {
		panic("invalid PCM sink call")
	}
	s.samples += len(pcm) / 4
	s.spans = append(s.spans, sourceAudioSpan{timestamp: timestamp, samples: len(pcm) / 4})
	s.borrowed = pcm
	for i := 0; i < len(pcm); i += 4 {
		value := int16(binary.LittleEndian.Uint16(pcm[i:]))
		s.energy += math.Pow(float64(value)/32768, 2)
		if value > 0 && s.previous <= 0 || value < 0 && s.previous >= 0 {
			s.crossings++
		}
		s.previous = value
	}
	return nil
}
func (s *decodedAudioFixture) Close() { s.mu.Lock(); s.closed = true; s.mu.Unlock() }

func TestSourceAudioDecoderConfiguration(t *testing.T) {
	valid := sourceAudioDecodeConfig{budget: sourceDecodeTestBudget(t), ffmpegPath: "never-executed", authorized: func() bool { return true }, revoked: make(chan struct{})}
	for _, mutate := range []func(*sourceAudioDecodeConfig){
		func(c *sourceAudioDecodeConfig) { c.budget = nil },
		func(c *sourceAudioDecodeConfig) { c.ffmpegPath = "" },
		func(c *sourceAudioDecodeConfig) { c.authorized = nil },
		func(c *sourceAudioDecodeConfig) { c.authorized = func() bool { return false } },
		func(c *sourceAudioDecodeConfig) { c.revoked = nil },
		func(c *sourceAudioDecodeConfig) { closed := make(chan struct{}); close(closed); c.revoked = closed },
	} {
		cfg := valid
		mutate(&cfg)
		if d, err := newSourceAudioDecoder(cfg, &decodedAudioFixture{}); err == nil || d != nil {
			t.Fatal("invalid source configuration accepted")
		}
	}
	if d, err := newSourceAudioDecoder(valid, nil); err == nil || d != nil {
		t.Fatal("missing mixer sink accepted")
	}
	pipe := &sourceOggPipe{}
	if _, err := pipe.Write(make([]byte, 513)); err == nil || pipe.header.Len() != 0 {
		t.Fatal("unbounded Ogg header")
	}
	args := sourceAudioDecodeArguments()
	for _, required := range []string{"pipe:0", "pipe:1", "48000", "2", "s16le", "-xerror"} {
		if !slices.Contains(args, required) {
			t.Fatal("audio decoder profile changed")
		}
	}
}

func sourceOpusFixture(t *testing.T, ffmpeg, duration string, packets int) [][]byte {
	return sourceOpusToneFixture(t, ffmpeg, duration, packets, 700)
}

func sourceOpusToneFixture(t *testing.T, ffmpeg, duration string, packets, frequency int) [][]byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	encoded, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
		"sine=frequency="+strconv.Itoa(frequency)+":sample_rate=48000", "-frames:a", strconv.Itoa(packets+2), "-ac", "2", "-c:a", "libopus",
		"-frame_duration", duration, "-page_duration", "2500", "-f", "ogg", "pipe:1").Output()
	if err != nil {
		t.Fatal("synthetic Opus generation failed")
	}
	defer clear(encoded)
	reader, _, err := oggreader.NewWith(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal("synthetic Opus header failed")
	}
	var result [][]byte
	for len(result) < packets {
		frame, header, err := reader.ParseNextPage()
		if err != nil {
			t.Fatal("synthetic Opus packet read failed")
		}
		if _, metadata := header.HeaderType(frame); metadata {
			continue
		}
		result = append(result, frame)
	}
	t.Cleanup(func() {
		for _, frame := range result {
			clear(frame)
		}
	})
	return result
}

func TestLiveTrustedSourceAudioDecoder(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit source audio gate requires FFmpeg")
	}
	t.Setenv("TURN_SHARED_SECRET", "synthetic-not-for-codec")
	for _, tc := range []struct {
		duration string
		samples  int
		packets  int
	}{{"2.5", 120, 80}, {"20", 960, 30}, {"60", 2880, 12}} {
		t.Run(tc.duration, func(t *testing.T) {
			frames := sourceOpusFixture(t, ffmpeg, tc.duration, tc.packets)
			var allowed atomic.Bool
			allowed.Store(true)
			revoked := make(chan struct{})
			sink := &decodedAudioFixture{}
			d, err := newSourceAudioDecoder(sourceAudioDecodeConfig{budget: sourceDecodeTestBudget(t), ffmpegPath: ffmpeg, authorized: allowed.Load, revoked: revoked}, sink)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Close)
			for _, entry := range d.cmd.Env {
				if strings.HasPrefix(entry, "TURN_SHARED_SECRET=") {
					t.Fatal("codec inherited application secret environment")
				}
			}
			preSkip := d.timeline.preSkip
			var expected []sourceAudioSpan
			for i, frame := range frames {
				samples, err := sourceOpusSamples(frame)
				if err != nil || samples != tc.samples {
					t.Fatal("fixture packet duration differs")
				}
				timestamp := uint32(uint64(0xffffe000) + uint64(i*tc.samples))
				if i >= len(frames)/2 {
					timestamp += 4800 // A real RTP time gap must not generate extra samples.
				}
				skip := min(max(preSkip-i*tc.samples, 0), tc.samples)
				if skip < tc.samples {
					expected = append(expected, sourceAudioSpan{timestamp: timestamp + uint32(skip), samples: tc.samples - skip})
				}
				if err = d.WriteEncoded("audio/opus", timestamp, frame); err != nil {
					t.Fatal(err)
				}
				clear(frame) // The asynchronous input writer must own its copy.
				time.Sleep(time.Duration(tc.samples) * time.Second / 48000)
			}
			want := tc.packets*tc.samples - preSkip
			deadline := time.Now().Add(time.Second)
			for {
				sink.mu.Lock()
				actual := sink.samples
				sink.mu.Unlock()
				if actual == want {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("source PCM sample deadline: got=%d want=%d", actual, want)
				}
				time.Sleep(10 * time.Millisecond)
			}
			if tc.duration == "20" {
				allowed.Store(false)
			} else {
				close(revoked)
			}
			select {
			case <-d.finished:
			case <-time.After(time.Second):
				t.Fatal("audio process survived idle revocation")
			}
			sink.mu.Lock()
			defer sink.mu.Unlock()
			rms := math.Sqrt(sink.energy / float64(sink.samples))
			frequency := float64(sink.crossings) * 48000 / (2 * float64(sink.samples))
			if !sink.closed || !slices.Equal(sink.spans, expected) || rms < 0.03 || rms > 0.15 || frequency < 650 || frequency > 750 {
				t.Fatalf("decoded tone/timestamps invalid: samples=%d rms=%.3f frequency=%.1f", sink.samples, rms, frequency)
			}
			if !bytes.Equal(sink.borrowed, make([]byte, len(sink.borrowed))) || d.cmd.ProcessState == nil || len(d.queue) != 0 {
				t.Fatal("source PCM/process/queue cleanup failed")
			}
		})
	}
	valid := sourceOpusFixture(t, ffmpeg, "20", 1)[0]
	for _, mode := range []string{"codec", "framing", "oversize", "duplicate", "overlap", "reverse", "budget", "process"} {
		t.Run(mode, func(t *testing.T) {
			sink := &decodedAudioFixture{}
			d, err := newSourceAudioDecoder(sourceAudioDecodeConfig{budget: sourceDecodeTestBudget(t), ffmpegPath: ffmpeg,
				authorized: func() bool { return true }, revoked: make(chan struct{})}, sink)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Close)
			codec, timestamp, frame := "audio/opus", uint32(40000), valid
			switch mode {
			case "codec":
				codec = "video/vp8"
			case "framing":
				frame = []byte{0x9b, 0}
			case "oversize":
				frame = make([]byte, 65536)
			case "duplicate", "overlap", "reverse":
				if err = d.WriteEncoded(codec, timestamp, frame); err != nil {
					t.Fatal(err)
				}
				if mode == "overlap" {
					timestamp++
				}
				if mode == "reverse" {
					timestamp--
				}
			case "budget":
				for i := uint32(0); i < 10000; i++ {
					if err = d.WriteEncoded(codec, timestamp+i*960, frame); err != nil {
						break
					}
				}
				if err == nil {
					t.Fatal("unbounded audio ingress")
				}
			case "process":
				if d.cmd.Process.Kill() != nil {
					t.Fatal("owned fixture process stop failed")
				}
			}
			if mode != "process" && mode != "budget" {
				if err = d.WriteEncoded(codec, timestamp, frame); err == nil {
					t.Fatal("invalid audio input accepted")
				}
			}
			select {
			case <-d.finished:
			case <-time.After(time.Second):
				t.Fatal("audio failure did not close its own decoder")
			}
			sink.mu.Lock()
			defer sink.mu.Unlock()
			if !sink.closed || d.cmd.ProcessState == nil || len(d.queue) != 0 {
				t.Fatal("failed audio source retained resources")
			}
			if mode != "budget" && sink.samples != 0 {
				t.Fatal("unauthorized first audio produced PCM")
			}
		})
	}
}
