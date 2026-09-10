package main

import (
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

// Real VP8 decoder and compositor, deliberately injected local sender reports.
// This proves decoder continuity, not network jitter or historical freeze cause.
func TestLiveVideoDecoderSurvivesClockQuarantine(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit clock recovery gate requires FFmpeg")
	}
	start := time.Unix(1700000000, 0)
	var elapsed atomic.Int64
	g, err := newSourcePublisherClock(start, func() time.Time { return start.Add(time.Duration(elapsed.Load())) }, 14400)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Close)
	c := mediaClockFixture(t, g, 7, 90000)
	report := func(ticks int, skew uint32) {
		elapsed.Store(int64(time.Duration(ticks) * time.Second / 30))
		if err := c.SourceSenderReport(sourceSenderReport{7, uint64(1000)<<32 + (uint64(ticks)<<32)/30, 100000 + uint32(ticks)*3000 + skew}); err != nil {
			t.Fatal(err)
		}
	}
	report(0, 0)
	report(3, 0)
	m := videoMixFixture(t, 1)
	input, err := m.Add(sourceVideoMixInputConfig{width: 64, height: 36, kind: "screen", fit: "contain", maxFrameAgeSamples: 24000,
		timeline: c, authorized: func() bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	sink := &countedVideoMixInput{sourceVideoMixInput: input}
	revoked := make(chan struct{})
	d, err := newSourceVideoDecoder(sourceVideoDecodeConfig{budget: sourceDecodeTestBudget(t), ffmpegPath: ffmpeg, width: 64, height: 36,
		authorized: func() bool { return true }, revoked: revoked}, sink)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		d.Close()
		select {
		case <-d.finished:
		case <-time.After(time.Second):
			t.Error("clock recovery decoder not reaped")
		}
	})
	frames := sourceVideoMixFixtureFrames(t, ffmpeg, "red", "blue")
	setVideoMixScene(t, m, "single", []*sourceVideoMixInput{input}, input)
	for frame := 0; frame < 20; frame++ {
		if frame == 3 {
			report(6, 2000)
		}
		if frame == 6 {
			report(9, 0)
		}
		if frame == 9 {
			report(12, 0)
		}
		if err := d.WriteEncoded("video/vp8", 109000+uint32(frame)*3000, frames[frame]); err != nil {
			t.Fatal("existing decoder stopped", err)
		}
		deadline := time.Now().Add(time.Second)
		for sink.count.Load() != int64(frame+1) {
			if time.Now().After(deadline) {
				t.Fatalf("decoder output absent at frame %d", frame)
			}
			time.Sleep(time.Millisecond)
		}
		renderVideoMix(t, m, int64(19200+frame*1600), func(p []byte) {
			color := videoMixColor(p, 64, 32, 18)
			if frame >= 3 && frame < 9 {
				if color != [4]byte{9, 19, 31, 255} {
					t.Fatal("uncertain clock emitted old pixels")
				}
			} else if color[1] > 30 || (frame%2 == 0 && color[0] < 200) || (frame%2 == 1 && color[2] < 200) {
				t.Fatalf("decoded moving source absent at frame %d", frame)
			}
		})
	}
	close(revoked)
	select {
	case <-d.finished:
	case <-time.After(time.Second):
		t.Fatal("recovered decoder ignored revoke")
	}
	if len(m.sources) != 0 || m.usedBytes != len(m.output) {
		t.Fatal("recovered decoder retained input after revoke")
	}
}
