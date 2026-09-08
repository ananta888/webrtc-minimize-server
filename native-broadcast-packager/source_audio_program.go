package main

// Separate output capability: resampled bytes already have program timestamps.
// No fake RTP identity mapping and no changed meaning for the existing RTP port.
type sourceProgramAudioMixInput struct{ input *sourceAudioMixInput }

type sourceProgramAudioInputConfig struct {
	authorized  func() bool
	left, right int
}

func (m *sourceAudioMixer) AddProgram(cfg sourceProgramAudioInputConfig) (*sourceProgramAudioMixInput, error) {
	s, err := m.add(sourceAudioMixInputConfig{authorized: cfg.authorized, left: cfg.left, right: cfg.right}, true)
	if err != nil {
		return nil, err
	}
	return &sourceProgramAudioMixInput{s}, nil
}

func (s *sourceProgramAudioMixInput) WriteProgramPCM(start int64, pcm []byte) error {
	s.input.mixer.mu.Lock()
	defer s.input.mixer.mu.Unlock()
	return s.input.writeProgramLocked(start, pcm, true)
}

func (s *sourceProgramAudioMixInput) Close() { s.input.Close() }
func (s *sourceProgramAudioMixInput) SetGain(left, right int) error {
	return s.input.SetGain(left, right)
}
