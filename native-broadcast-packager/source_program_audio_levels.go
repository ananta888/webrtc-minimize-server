package main

import (
	"errors"
	"math"
	"sort"
)

type sourceProgramAudioLevel struct {
	SourceLeaseID string `json:"sourceLeaseId"`
	Left          int    `json:"leftGainQ15"`
	Right         int    `json:"rightGainQ15"`
	Muted         bool   `json:"muted"`
}

type sourceProgramAudioSource struct {
	sourceProgramAudioLevel
	SourceKind string `json:"sourceKind"`
}

type sourceProgramAudioState struct {
	Revision uint64                      `json:"audioRevision"`
	Sources  []sourceProgramAudioSource  `json:"sources"`
	Mix      *sourceProgramAudioMix      `json:"mix,omitempty"`
	Encoding *sourceProgramAudioEncoding `json:"encoding,omitempty"`
}

type sourceProgramAudioMix struct {
	Strategy        string `json:"strategy"`
	MicrophoneGain  int    `json:"microphoneGainQ15"`
	ScreenAudioGain int    `json:"screenAudioGainQ15"`
	LimiterGain     int    `json:"limiterGainQ15"`
	Peak            int    `json:"peakQ15"`
}
type sourceProgramAudioRendition struct {
	ID                  string `json:"id"`
	TargetBitsPerSecond int    `json:"targetBitsPerSecond"`
}
type sourceProgramAudioEncoding struct {
	Codec      string                        `json:"codec"`
	SampleRate int                           `json:"sampleRate"`
	Channels   int                           `json:"channels"`
	Renditions []sourceProgramAudioRendition `json:"renditions"`
}

// A bounded local presentation snapshot, never a new source/decoder admission.
func (p *sourceProgramGeneration) AudioLevels() (sourceProgramAudioState, error) {
	return p.audioLevels(1)
}

func (p *sourceProgramGeneration) audioLevels(version int) (sourceProgramAudioState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permitted() || version < 1 || version > 3 || version == 2 && p.cfg.encoder.outputAudioChannels() != 2 {
		return sourceProgramAudioState{}, errors.New("source program audio unavailable")
	}
	levels, err := p.audio.Levels()
	if err != nil {
		return sourceProgramAudioState{}, err
	}
	state := sourceProgramAudioState{Revision: levels.revision, Sources: []sourceProgramAudioSource{}}
	if version == 2 || version == 3 {
		q15 := func(v float64) int { return max(0, min(32768, int(math.Round(v*32768)))) }
		state.Mix = &sourceProgramAudioMix{levels.strategy, q15(levels.dynamics.microphone), q15(levels.dynamics.screen), q15(levels.dynamics.limiter), levels.dynamics.peak}
		state.Encoding = &sourceProgramAudioEncoding{Codec: "aac", SampleRate: 48000, Channels: p.cfg.encoder.outputAudioChannels(), Renditions: []sourceProgramAudioRendition{}}
		for _, rendition := range p.cfg.encoder.profile.Renditions {
			state.Encoding.Renditions = append(state.Encoding.Renditions, sourceProgramAudioRendition{rendition.ID, rendition.AudioBitsPerSecond})
		}
	}
	for id, source := range p.sources {
		level, exists := levels.inputs[source.audio]
		if !exists || source.closed.Load() || !source.allowed() {
			continue
		}
		state.Sources = append(state.Sources, sourceProgramAudioSource{
			sourceProgramAudioLevel{id, level.left, level.right, level.muted}, source.kind,
		})
	}
	sort.Slice(state.Sources, func(i, j int) bool { return state.Sources[i].SourceLeaseID < state.Sources[j].SourceLeaseID })
	return state, nil
}

func (p *sourceProgramGeneration) SetAudioLevels(expected uint64, changes []sourceProgramAudioLevel, current func() bool) (uint64, error) {
	return p.setAudioLevelsStrategy(expected, changes, nil, current)
}

func (p *sourceProgramGeneration) setAudioLevelsStrategy(expected uint64, changes []sourceProgramAudioLevel, strategy *string, current func() bool) (uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	denied := func() (uint64, error) { return 0, errors.New("source program audio selection denied") }
	if !p.permitted() || len(changes) == 0 && strategy == nil || len(changes) > 80 || current == nil {
		return denied()
	}
	inputs := make([]sourceAudioLevelChange, 0, len(changes))
	for _, change := range changes {
		source := p.sources[change.SourceLeaseID]
		if source == nil || source.audio == nil || source.closed.Load() || !source.allowed() {
			return denied()
		}
		inputs = append(inputs, sourceAudioLevelChange{source.audio, sourceAudioLevels{change.Left, change.Right, change.Muted}})
	}
	return p.audio.setLevelsStrategy(expected, inputs, strategy, func() bool { return p.permitted() && current() })
}
