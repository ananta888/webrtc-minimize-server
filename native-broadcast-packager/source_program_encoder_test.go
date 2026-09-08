package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func sourceEncoderTestConfig(root string) sourceProgramEncoderConfig {
	p := transcodeAssignment().Profile
	p.KeyframeIntervalSeconds = 1
	p.Renditions = []assignmentRendition{{ID: "low", Width: 160, Height: 90, FramesPerSecond: 5, VideoBitsPerSecond: 100000, AudioBitsPerSecond: 32000},
		{ID: "medium", Width: 320, Height: 180, FramesPerSecond: 10, VideoBitsPerSecond: 200000, AudioBitsPerSecond: 64000}}
	return sourceProgramEncoderConfig{ffmpegPath: "ffmpeg", outputRoot: root, resourceRef: "res_aaaaaaaaaaaaaaaa", packagerID: outputTestOwner,
		width: 64, height: 36, fps: 10, profile: p, maxRawBytes: 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, authorized: func() bool { return true }, revoked: make(chan struct{})}
}

func TestSourceEncoderArgumentsKeepRawAndLegacyInputsSeparate(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	args := sourceProgramEncoderArguments(c, "/owned/.pending", "pipe:3", "pipe:4")
	joined := strings.Join(args, " ")
	for _, fps := range []string{"fps=fps=5:round=near", "fps=fps=10:round=near"} {
		if !strings.Contains(joined, fps) {
			t.Fatal("raw rendition has no explicit frame selection")
		}
	}
	for _, required := range []string{"-f rawvideo -pixel_format rgba -video_size 64x36 -framerate 10 -i pipe:3", "-f s16le -ar 48000 -ac 2", "-i pipe:4", "-c:v:0 libx264", "-c:a:0 aac", "-hls_segment_type fmp4", "temp_file"} {
		if !strings.Contains(joined, required) {
			t.Fatal("raw codec profile missing", required)
		}
	}
	legacy := ffmpegTranscodeArgumentsForInputs(&packagerAssignment{Profile: c.profile}, "/owned", true, true, "libx264", "pipe:3", "pipe:4")
	prefix := []string{"-hide_banner", "-nostdin", "-loglevel", "warning", "-f", "ivf", "-i", "pipe:3", "-f", "ogg", "-i", "pipe:4"}
	want := append(prefix, ffmpegTranscodeOutputArguments(&packagerAssignment{Profile: c.profile}, "/owned", "libx264")...)
	if !reflect.DeepEqual(legacy, want) {
		t.Fatal("legacy container contract changed")
	}
}

func TestSourceEncoderRejectsConfigBeforeOwningOutput(t *testing.T) {
	base := sourceEncoderTestConfig(t.TempDir())
	for _, change := range []func(*sourceProgramEncoderConfig){
		func(c *sourceProgramEncoderConfig) { c.width = 0 }, func(c *sourceProgramEncoderConfig) { c.fps = 61 },
		func(c *sourceProgramEncoderConfig) { c.startSample = -1 }, func(c *sourceProgramEncoderConfig) { c.profile.ProfileID = "unknown" },
		func(c *sourceProgramEncoderConfig) { c.profile.VideoEncoder = "untrusted" }, func(c *sourceProgramEncoderConfig) { c.profile.MaximumQueueFrames = 1 },
		func(c *sourceProgramEncoderConfig) { c.maxRawBytes = 1 }, func(c *sourceProgramEncoderConfig) { c.maxOutputBytes = 129 * 1024 * 1024 },
		func(c *sourceProgramEncoderConfig) { c.authorized = func() bool { return false } }, func(c *sourceProgramEncoderConfig) { c.authorized = nil },
		func(c *sourceProgramEncoderConfig) { c.revoked = nil }, func(c *sourceProgramEncoderConfig) { ch := make(chan struct{}); close(ch); c.revoked = ch },
		func(c *sourceProgramEncoderConfig) { c.resourceRef = "../escape" }, func(c *sourceProgramEncoderConfig) { c.packagerID = "unknown" },
	} {
		c := base
		change(&c)
		p, err := newSourceProgramEncoder(c)
		if p != nil || err == nil {
			if p != nil {
				p.Close()
				awaitSource(t, p.finished)
			}
			t.Fatal("invalid encoder configuration accepted")
		}
	}
	if _, err := os.Stat(filepath.Join(base.outputRoot, base.resourceRef)); !os.IsNotExist(err) {
		t.Fatal("denied encoder touched output")
	}
}

func TestSourceEncoderFailedSpawnReleasesExactOwnedOutput(t *testing.T) {
	c := sourceEncoderTestConfig(t.TempDir())
	c.ffmpegPath = filepath.Join(c.outputRoot, "missing-ffmpeg")
	if p, err := newSourceProgramEncoder(c); p != nil || err == nil {
		t.Fatal("missing encoder accepted")
	}
	if _, err := os.Stat(filepath.Join(c.outputRoot, c.resourceRef)); !os.IsNotExist(err) {
		t.Fatal("failed spawn retained output")
	}
	o, err := acquireOutputOwnership(c.outputRoot, c.resourceRef, c.packagerID)
	if err != nil {
		t.Fatal("failed spawn retained lock", err)
	}
	if err = o.close(); err != nil {
		t.Fatal(err)
	}
}
