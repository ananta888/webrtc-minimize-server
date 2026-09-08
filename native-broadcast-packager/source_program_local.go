package main

import (
	"errors"
	"time"
)

// Operator-owned capacity only. These profiles confer no source permission and
// bound owned buffers, not codec RSS, kernel buffers, CPU or upload throughput.
type sourceProgramBudget struct {
	decoders, pcmBytes, rgbaBytes, rawBytes int
	decodeBytes, outputBytes                int64
	width, height                           int
}

func sourceProgramLocalBudget(name string) (sourceProgramBudget, error) {
	const mib = 1024 * 1024
	switch name {
	case "compact-v1":
		return sourceProgramBudget{8, 2 * mib, 32 * mib, 64 * mib, 128 * mib, 32 * mib, 640, 360}, nil
	case "standard-v1":
		return sourceProgramBudget{24, 8 * mib, 128 * mib, 96 * mib, 384 * mib, 64 * mib, 960, 540}, nil
	case "expanded-v1":
		return sourceProgramBudget{80, 14 * mib, 256 * mib, 128 * mib, 1536 * mib, 128 * mib, 1280, 720}, nil
	default:
		return sourceProgramBudget{}, errors.New("NATIVE_PACKAGER_SOURCE_BUDGET is invalid")
	}
}

// Only called with a parsed v4 assignment, but validate it again at this small
// boundary before arithmetic. No resources, authority or output are created here.
func localSourceProgramConfig(c config, a sourceProgramAssignment, now time.Time) (sourceProgramGenerationConfig, error) {
	b, err := sourceProgramLocalBudget(c.sourceBudget)
	if err != nil || !validSourceProgramAssignment(a, now) {
		return sourceProgramGenerationConfig{}, errors.New("source local config denied")
	}
	w, h, fps := 0, 0, 0
	pixels := int64(0)
	for _, r := range a.Profile.Renditions {
		w, h, fps = max(w, r.Width), max(h, r.Height), max(fps, r.FramesPerSecond)
		pixels += int64(r.Width) * int64(r.Height) * int64(r.FramesPerSecond)
	}
	raw := min(16, a.Profile.MaximumQueueFrames)*3840 + min(8, a.Profile.MaximumQueueFrames)*w*h*4
	if c.maximumRenditions < len(a.Profile.Renditions) || c.maximumRenditions > 3 || c.maximumPixelsPerSecond < 1 ||
		pixels > int64(c.maximumPixelsPerSecond) || int64(w)*int64(h)*int64(fps) > int64(c.maximumPixelsPerSecond) ||
		a.Profile.MaximumQueueFrames < 2 || raw > b.rawBytes || w*h*4 > b.rgbaBytes {
		return sourceProgramGenerationConfig{}, errors.New("source local capacity denied")
	}
	// The owner supplies the trusted scope, lifecycle and local executable/path.
	// Renditions are neither rewritten nor downgraded when admission fails.
	return sourceProgramGenerationConfig{
		encoder:       sourceProgramEncoderConfig{width: w, height: h, fps: fps, maxRawBytes: raw, maxOutputBytes: b.outputBytes},
		maxPublishers: 20, maxSources: 80, maxDecoders: b.decoders, maxDecodeBytes: b.decodeBytes,
		maxPCMBytes: b.pcmBytes, maxRGBABytes: b.rgbaBytes,
		sourceWidth: min(w, b.width), sourceHeight: min(h, b.height), delaySamples: 14400,
	}, nil
}

// Local adapter to the real fenced owner. Public dispatch/capability promotion
// remains separate until source recovery and full ingress acceptance are ready.
func (c *client) prepareLocalSourceProgramAssignment(raw []byte, now time.Time, create sourceProgramGenerationFactory) error {
	a, err := parseSourceProgramAssignment(raw, now)
	if err != nil {
		return err
	}
	local, err := localSourceProgramConfig(c.cfg, a, now)
	if err != nil {
		return err
	}
	return c.prepareSourceProgramAssignment(raw, now, local, create)
}
