package main

import "errors"

const sourceAudioLevelMaxRevision uint64 = 9007199254740991

type sourceAudioLevels struct {
	left, right int
	muted       bool
}

type sourceAudioLevelChange struct {
	input  *sourceAudioMixInput
	levels sourceAudioLevels
}

// Local handles, not remote identities. No authority or PCM leaves this snapshot.
type sourceAudioLevelState struct {
	revision uint64
	inputs   map[*sourceAudioMixInput]sourceAudioLevels
}

func (m *sourceAudioMixer) advanceRevisionLocked() bool {
	if m.revision >= sourceAudioLevelMaxRevision {
		m.closeLocked()
		return false
	}
	m.revision++
	return true
}

func (m *sourceAudioMixer) currentLevelsLocked() bool {
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		return false
	}
	for input := range m.sources {
		if !input.cfg.authorized() {
			input.closeLocked()
		}
	}
	return !m.closed
}

func (m *sourceAudioMixer) Levels() (sourceAudioLevelState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.currentLevelsLocked() {
		return sourceAudioLevelState{}, errors.New("source audio levels unavailable")
	}
	state := sourceAudioLevelState{revision: m.revision, inputs: make(map[*sourceAudioMixInput]sourceAudioLevels, len(m.sources))}
	for input := range m.sources {
		state.inputs[input] = sourceAudioLevels{input.cfg.left, input.cfg.right, input.muted}
	}
	return state, nil
}

// All sources and the current command fence are checked before any level changes.
// Source revocation remains independent and is checked again on every render.
func (m *sourceAudioMixer) SetLevels(expected uint64, changes []sourceAudioLevelChange, current func() bool) (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	denied := func() (uint64, error) { return 0, errors.New("source audio levels denied") }
	if !m.currentLevelsLocked() || expected != m.revision || expected == 0 || len(changes) == 0 || len(changes) > 80 || current == nil {
		return denied()
	}
	seen := make(map[*sourceAudioMixInput]bool, len(changes))
	for _, change := range changes {
		s := change.input
		if _, exists := m.sources[s]; !exists || s == nil || s.mixer != m || s.closed || seen[s] ||
			!s.cfg.authorized() || !validSourceAudioGain(change.levels.left, change.levels.right) {
			return denied()
		}
		seen[s] = true
	}
	if !current() || !m.cfg.authorized() {
		return denied()
	}
	for _, change := range changes {
		if !change.input.cfg.authorized() {
			return denied()
		}
	}
	if !m.advanceRevisionLocked() {
		return denied()
	}
	for _, change := range changes {
		change.input.cfg.left, change.input.cfg.right, change.input.muted = change.levels.left, change.levels.right, change.levels.muted
	}
	return m.revision, nil
}
