package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
)

type countedVideoMixInput struct {
	*sourceVideoMixInput
	count atomic.Int64
}

func (s *countedVideoMixInput) WriteRGBA(width, height int, timestamp uint32, pixels []byte) error {
	if err := s.sourceVideoMixInput.WriteRGBA(width, height, timestamp, pixels); err != nil {
		return err
	}
	s.count.Add(1)
	return nil
}

func sourceVideoMixFixtureFrames(t *testing.T, ffmpeg, background, foreground string) [][]byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	encoded, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
		"color="+background+":size=64x36:rate=30", "-vf", "drawbox=color="+foreground+":t=fill:enable='mod(n,2)'",
		"-frames:v", "40", "-an", "-c:v", "libvpx", "-threads", "1", "-deadline", "realtime", "-f", "ivf", "pipe:1").Output()
	if err != nil {
		t.Fatal("synthetic compositor VP8 generation failed")
	}
	defer clear(encoded)
	reader, _, err := ivfreader.NewWith(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal("synthetic compositor IVF header failed")
	}
	frames := make([][]byte, 40)
	for i := range frames {
		frames[i], _, err = reader.ParseNextFrame()
		if err != nil {
			t.Fatal("synthetic compositor IVF frame failed")
		}
	}
	t.Cleanup(func() {
		for _, frame := range frames {
			clear(frame)
		}
	})
	return frames
}

func TestLiveTrustedSourceVideoMixer(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit source compositor gate requires FFmpeg")
	}
	m := videoMixFixture(t, 2)
	var decoders [2]*sourceVideoDecoder
	var sinks [2]*countedVideoMixInput
	var frames [2][][]byte
	var revoked [2]chan struct{}
	bases := [2]uint32{0xffffe000, 7654321}
	for index, colors := range [][2]string{{"red", "blue"}, {"blue", "red"}} {
		frames[index] = sourceVideoMixFixtureFrames(t, ffmpeg, colors[0], colors[1])
		base := bases[index]
		kind := "camera"
		if index == 1 {
			kind = "screen"
		}
		input, err := m.Add(sourceVideoMixInputConfig{width: 64, height: 36, kind: kind, fit: "contain", maxFrameAgeSamples: 24000,
			authorized: func() bool { return true }, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts-base) * 8 / 15, true }})
		if err != nil {
			t.Fatal(err)
		}
		// Explicit known synthetic 90-kHz clocks, not a network/RTCP sync claim.
		sinks[index] = &countedVideoMixInput{sourceVideoMixInput: input}
		revoked[index] = make(chan struct{})
		d, err := newSourceVideoDecoder(sourceVideoDecodeConfig{ffmpegPath: ffmpeg, width: 64, height: 36,
			authorized: func() bool { return true }, revoked: revoked[index]}, sinks[index])
		if err != nil {
			t.Fatal(err)
		}
		decoders[index] = d
		t.Cleanup(func() {
			d.Close()
			select {
			case <-d.finished:
			case <-time.After(time.Second):
				t.Error("compositor decoder not reaped")
			}
		})
	}
	writeFrame := func(index, frame int) {
		t.Helper()
		if err := decoders[index].WriteEncoded("video/vp8", bases[index]+uint32(frame*3000), frames[index][frame]); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(time.Second)
		for sinks[index].count.Load() != int64(frame+1) {
			if time.Now().After(deadline) {
				t.Fatalf("compositor decoded frame deadline: source=%d frame=%d count=%d", index, frame, sinks[index].count.Load())
			}
			time.Sleep(time.Millisecond)
		}
	}
	inputs := []*sourceVideoMixInput{sinks[0].sourceVideoMixInput, sinks[1].sourceVideoMixInput}
	setVideoMixScene(t, m, "side-by-side", inputs, nil)
	changes, lastRed, observed := [2]int{}, [2]bool{}, [2]bool{}
	for frame := 0; frame < 40; frame++ {
		if frame < 20 {
			writeFrame(0, frame)
		}
		writeFrame(1, frame)
		if frame == 10 {
			setVideoMixScene(t, m, "screen-presenter", inputs, nil)
		}
		if frame == 19 {
			setVideoMixScene(t, m, "side-by-side", inputs, nil)
		}
		if frame == 26 {
			setVideoMixScene(t, m, "single", inputs[1:], inputs[1])
		}
		renderVideoMix(t, m, int64(frame*1600), func(pixels []byte) {
			for _, rect := range m.rects {
				color := videoMixColor(pixels, 64, rect.x+rect.width/2, rect.y+rect.height/2)
				s := m.scene[rect.source]
				if s == nil {
					if color != [4]byte{9, 19, 31, 255} {
						t.Fatal("revoked cached image is still in composed frame")
					}
					continue
				}
				index := 0
				if s == inputs[1] {
					index = 1
				}
				red := (frame+index)%2 == 0
				if color[1] > 30 || color[3] != 255 || red && (color[0] < 200 || color[2] > 30) || !red && (color[2] < 200 || color[0] > 30) {
					t.Fatalf("wrong decoded source pixels: source=%d frame=%d color=%v", index, frame, color)
				}
				if observed[index] && red != lastRed[index] {
					changes[index]++
				}
				observed[index], lastRed[index] = true, red
			}
		})
		if frame == 19 {
			// Revoke both a currently presented and two future decoded images.
			writeFrame(0, 20)
			writeFrame(0, 21)
			m.mu.Lock()
			retained := make([][]byte, len(inputs[0].frames))
			for i := range retained {
				retained[i] = inputs[0].frames[i].pixels
			}
			m.mu.Unlock()
			close(revoked[0])
			select {
			case <-decoders[0].finished:
			case <-time.After(time.Second):
				t.Fatal("source revoke did not stop decoder")
			}
			for _, pixels := range retained {
				if !bytes.Equal(pixels, make([]byte, len(pixels))) {
					t.Fatal("decoded image pool survived revoke")
				}
			}
		}
	}
	if changes[0] != 19 || changes[1] != 39 {
		t.Fatalf("composited video froze: changes=%v", changes)
	}
	close(revoked[1])
	select {
	case <-decoders[1].finished:
	case <-time.After(time.Second):
		t.Fatal("last source did not stop")
	}
	renderVideoMix(t, m, 40*1600, func(pixels []byte) {
		if !bytes.Equal(pixels, solidVideoMix(64, 36, 9, 19, 31)) {
			t.Fatal("final slate retained media")
		}
	})
	if m.closed || len(m.sources) != 0 || m.usedBytes != len(m.output) {
		t.Fatal("source revoke damaged parent or retained resources")
	}
}
