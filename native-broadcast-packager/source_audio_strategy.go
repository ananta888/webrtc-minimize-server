package main

import (
	"encoding/binary"
	"math"
)

// Strategies change only the authorized PCM bus, never source or encoder policy.
// All analysis uses one existing 20-ms block; no media history/extra queue exists.
func validSourceAudioStrategy(value string) bool {
	return oneOf(value, "unprocessed", "balanced", "speech-first", "screen-first")
}

type sourceAudioDynamics struct {
	microphone, screen, limiter float64
	peak                        int
}

func initialSourceAudioDynamics() sourceAudioDynamics {
	return sourceAudioDynamics{microphone: 1, screen: 1, limiter: 1}
}

// A 20-ms attack and approximately 300-ms release, on the program sample clock.
func sourceAudioDuckStep(previous, target float64) float64 {
	if target < previous {
		return target
	}
	return previous + (target-previous)/15
}

func (m *sourceAudioMixer) strategyTargetsLocked() (float64, float64) {
	if m.strategy == "unprocessed" {
		return 1, 1
	}
	microphone, screen := false, false
	threshold := int64(1475) // About 4.5% full-scale RMS, after user gain/mute.
	for s := range m.sources {
		if !s.cfg.authorized() {
			s.closeLocked()
			continue
		}
		if s.muted || s.cfg.kind == "" {
			continue
		}
		var energy int64
		for i := 0; i < sourceAudioMixSamples; i++ {
			index := int((m.cursor+int64(i))%int64(m.cfg.queueSamples)) * 2
			left := int64(s.pcm[index]) * int64(s.cfg.left) / 32768
			right := int64(s.pcm[index+1]) * int64(s.cfg.right) / 32768
			energy += left*left + right*right
		}
		if energy >= threshold*threshold*sourceAudioMixSamples*2 {
			if s.cfg.kind == "microphone" {
				microphone = true
			}
			if s.cfg.kind == "screen-audio" {
				screen = true
			}
		}
	}
	if m.strategy == "screen-first" && screen {
		return .28, 1
	}
	if microphone && m.strategy == "speech-first" {
		return 1, .28
	}
	if microphone && m.strategy == "balanced" {
		return 1, .5
	}
	return 1, 1
}

func (m *sourceAudioMixer) renderStrategyLocked() {
	var peak int64
	for _, sum := range m.sum {
		peak = max(peak, int64(math.Abs(float64(sum/32768))))
	}
	if m.strategy == "unprocessed" {
		m.dynamics.limiter = 1
	} else {
		const ceiling = 29490 // Linked stereo peak ceiling, approximately -0.92 dBFS.
		target := 1.0
		if peak > ceiling {
			target = float64(ceiling) / float64(peak)
		}
		// Current block look-ahead permits immediate reduction without delay.
		m.dynamics.limiter = sourceAudioDuckStep(m.dynamics.limiter, target)
	}
	m.dynamics.peak = 0
	for i, sum := range m.sum {
		value := max(-32768, min(32767, int64(float64(sum/32768)*m.dynamics.limiter)))
		m.dynamics.peak = max(m.dynamics.peak, int(math.Abs(float64(value))))
		binary.LittleEndian.PutUint16(m.output[i*2:], uint16(int16(value)))
	}
}
