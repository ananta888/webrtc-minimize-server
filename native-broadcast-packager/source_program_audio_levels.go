package main

import (
	"errors"
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
	Revision uint64                     `json:"audioRevision"`
	Sources  []sourceProgramAudioSource `json:"sources"`
}

// A bounded local presentation snapshot, never a new source/decoder admission.
func (p *sourceProgramGeneration) AudioLevels() (sourceProgramAudioState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permitted() {
		return sourceProgramAudioState{}, errors.New("source program audio unavailable")
	}
	levels, err := p.audio.Levels()
	if err != nil {
		return sourceProgramAudioState{}, err
	}
	state := sourceProgramAudioState{Revision: levels.revision, Sources: []sourceProgramAudioSource{}}
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
	p.mu.Lock()
	defer p.mu.Unlock()
	denied := func() (uint64, error) { return 0, errors.New("source program audio selection denied") }
	if !p.permitted() || len(changes) == 0 || len(changes) > 80 || current == nil {
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
	return p.audio.SetLevels(expected, inputs, func() bool { return p.permitted() && current() })
}
