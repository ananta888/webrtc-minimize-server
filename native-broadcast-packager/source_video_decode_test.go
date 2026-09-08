package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
)

func syntheticVP8Key() []byte {
	return []byte{0x10, 0, 0, 0x9d, 1, 0x2a, 64, 0, 32, 0}
}

func TestSourceVideoFrameBoundary(t *testing.T) {
	width, height, key, err := sourceVP8Dimensions(syntheticVP8Key())
	if err != nil || width != 64 || height != 32 || !key {
		t.Fatal("keyframe dimensions")
	}
	if _, _, key, err = sourceVP8Dimensions([]byte{0x11, 0, 0}); err != nil || key {
		t.Fatal("displayed delta frame")
	}
	for _, mutate := range []func([]byte) []byte{
		func([]byte) []byte { return nil },
		func(b []byte) []byte { return b[:2] },
		func(b []byte) []byte { return b[:9] },
		func(b []byte) []byte { b[0] &^= 0x10; return b },
		func(b []byte) []byte { b[0] |= 8; return b },
		func(b []byte) []byte { b[3] = 0; return b },
		func(b []byte) []byte { binary.LittleEndian.PutUint16(b[6:8], 1921); return b },
		func(b []byte) []byte { binary.LittleEndian.PutUint16(b[8:10], 1081); return b },
		func(b []byte) []byte { b[6] = 1; return b },
		func(b []byte) []byte { return append(b, make([]byte, sourceVideoFrameLimit)...) },
	} {
		if _, _, _, err := sourceVP8Dimensions(mutate(syntheticVP8Key())); err == nil {
			t.Fatal("invalid VP8 accepted")
		}
	}
}

type decodedVideoFixture struct {
	mu         sync.Mutex
	count      int
	closed     bool
	red        bool
	blue       bool
	changes    int
	timestamps []uint32
	borrowed   []byte
}

func (s *decodedVideoFixture) WriteRGBA(width, height int, timestamp uint32, pixels []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		panic("late output after invalidation")
	}
	s.count++
	s.timestamps = append(s.timestamps, timestamp)
	s.borrowed = pixels
	red := width == 64 && height == 32 && len(pixels) == width*height*4 &&
		pixels[0] > 200 && pixels[1] < 30 && pixels[2] < 30 && pixels[3] == 255
	blue := width == 64 && height == 32 && len(pixels) == width*height*4 &&
		pixels[0] < 30 && pixels[1] < 30 && pixels[2] > 200 && pixels[3] == 255
	if s.count > 1 && red != s.red && blue != s.blue {
		s.changes++
	}
	s.red, s.blue = red, blue
	return nil
}
func (s *decodedVideoFixture) Close() { s.mu.Lock(); s.closed = true; s.mu.Unlock() }

func TestSourceVideoDecoderClosedConfiguration(t *testing.T) {
	valid := sourceVideoDecodeConfig{ffmpegPath: "not-executed", width: 64, height: 32,
		authorized: func() bool { return true }, revoked: make(chan struct{})}
	for _, mutate := range []func(*sourceVideoDecodeConfig){
		func(c *sourceVideoDecodeConfig) { c.ffmpegPath = "" },
		func(c *sourceVideoDecodeConfig) { c.width = 1922 },
		func(c *sourceVideoDecodeConfig) { c.height = 1082 },
		func(c *sourceVideoDecodeConfig) { c.width = 1 },
		func(c *sourceVideoDecodeConfig) { c.height = 3 },
		func(c *sourceVideoDecodeConfig) { c.authorized = nil },
		func(c *sourceVideoDecodeConfig) { c.authorized = func() bool { return false } },
		func(c *sourceVideoDecodeConfig) { c.revoked = nil },
		func(c *sourceVideoDecodeConfig) { revoked := make(chan struct{}); close(revoked); c.revoked = revoked },
	} {
		cfg := valid
		mutate(&cfg)
		if d, err := newSourceVideoDecoder(cfg, &decodedVideoFixture{}); err == nil || d != nil {
			t.Fatal("invalid config started a decoder")
		}
	}
	args := sourceVideoDecodeArguments(64, 32)
	if !slices.Contains(args, "pipe:0") || !slices.Contains(args, "pipe:1") || !slices.Contains(args, "rawvideo") ||
		!slices.Contains(args, "-xerror") || strings.Contains(strings.Join(args, " "), "http") {
		t.Fatal("unsafe decoder profile")
	}
}

func TestLiveTrustedSourceVideoDecoder(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit decoder gate requires FFmpeg")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	encoded, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
		"color=red:size=64x32:rate=30", "-vf", "drawbox=color=blue:t=fill:enable='mod(n,2)'", "-frames:v", "30", "-an", "-c:v", "libvpx", "-threads", "1",
		"-deadline", "realtime", "-f", "ivf", "pipe:1").Output()
	if err != nil {
		t.Fatal("synthetic VP8 generation failed")
	}
	defer clear(encoded)
	for _, revokeMode := range []string{"signal", "policy"} {
		t.Run(revokeMode, func(t *testing.T) {
			reader, _, err := ivfreader.NewWith(bytes.NewReader(encoded))
			if err != nil {
				t.Fatal("synthetic VP8 container failed")
			}
			var allowed atomic.Bool
			allowed.Store(true)
			revoked := make(chan struct{})
			sink := &decodedVideoFixture{}
			d, err := newSourceVideoDecoder(sourceVideoDecodeConfig{ffmpegPath: ffmpeg, width: 64, height: 32,
				authorized: allowed.Load, revoked: revoked}, sink)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Close)
			var expected []uint32
			for i := 0; i < 20; i++ {
				frame, _, readErr := reader.ParseNextFrame()
				if readErr != nil {
					t.Fatal("synthetic frame read")
				}
				// Exercise RTP timestamp wrap, not just a zero-based fixture.
				ts := uint32(0xffffe000 + uint64(i)*3000)
				expected = append(expected, ts)
				if err = d.WriteEncoded("video/vp8", ts, frame); err != nil {
					t.Fatal(err)
				}
				clear(frame)
				time.Sleep(time.Second / 30)
			}
			deadline := time.Now().Add(time.Second)
			for {
				sink.mu.Lock()
				count, red, blue, changes := sink.count, sink.red, sink.blue, sink.changes
				sink.mu.Unlock()
				if count == len(expected) {
					if (!red && !blue) || changes != 19 {
						t.Fatal("decoded source pixels did not alternate on every input frame")
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("bounded decode deadline: decoded=%d expected=%d", count, len(expected))
				}
				time.Sleep(10 * time.Millisecond)
			}
			if revokeMode == "signal" {
				close(revoked)
			} else {
				allowed.Store(false)
			}
			select {
			case <-d.finished:
			case <-time.After(time.Second):
				t.Fatal("decoder did not exit after idle revoke")
			}
			sink.mu.Lock()
			defer sink.mu.Unlock()
			if !sink.closed || !slices.Equal(sink.timestamps, expected) || !bytes.Equal(sink.borrowed, make([]byte, 64*32*4)) {
				t.Fatal("timestamp, source invalidation or borrowed pixel cleanup failed")
			}
			if d.cmd.ProcessState == nil || len(d.queue) != 0 {
				t.Fatal("decoder process or source queue survived")
			}
		})
	}
	for _, mode := range []string{"codec", "dimension", "duplicate", "reverse", "hidden", "corrupt", "budget"} {
		t.Run(mode, func(t *testing.T) {
			sink := &decodedVideoFixture{}
			d, err := newSourceVideoDecoder(sourceVideoDecodeConfig{ffmpegPath: ffmpeg, width: 64, height: 32,
				authorized: func() bool { return true }, revoked: make(chan struct{})}, sink)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Close)
			reader, _, _ := ivfreader.NewWith(bytes.NewReader(encoded))
			frame, _, _ := reader.ParseNextFrame()
			defer clear(frame)
			codec, timestamp := "video/vp8", uint32(10000)
			switch mode {
			case "codec":
				codec = "audio/opus"
			case "dimension":
				binary.LittleEndian.PutUint16(frame[6:8], 1921)
			case "duplicate", "reverse":
				if err = d.WriteEncoded(codec, timestamp, frame); err != nil {
					t.Fatal(err)
				}
				if mode == "reverse" {
					timestamp--
				}
			case "hidden":
				frame[0] &^= 0x10
			case "corrupt":
				frame = frame[:10] // Structurally bounded header, invalid coded payload.
			case "budget":
				// Write faster than the bounded decoder can consume; no growable queue.
				for i := uint32(0); i < 10000; i++ {
					err = d.WriteEncoded(codec, timestamp+i*3000, frame)
					if err != nil {
						break
					}
				}
				if err == nil {
					t.Fatal("unbounded decoder ingress")
				}
			}
			if mode != "budget" {
				err = d.WriteEncoded(codec, timestamp, frame)
				if mode != "corrupt" && err == nil {
					t.Fatal("invalid source input accepted")
				}
			}
			select {
			case <-d.finished:
			case <-time.After(3 * time.Second):
				t.Fatal("invalid source decoder survived bounded shutdown")
			}
			sink.mu.Lock()
			defer sink.mu.Unlock()
			if !sink.closed || d.cmd.ProcessState == nil || len(d.queue) != 0 {
				t.Fatal("invalid source cleanup failed")
			}
			if mode != "duplicate" && mode != "reverse" && mode != "budget" && sink.count != 0 {
				t.Fatal("invalid first frame produced source pixels")
			}
		})
	}
}
