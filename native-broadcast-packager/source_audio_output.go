package main

// Immutable output selection for a new program assignment only. The upstream
// PCM mixer remains stereo; channels describe the AAC encoder output, not capture.
type sourceAudioEncodingSelection struct {
	Codec               string `json:"codec"`
	SampleRate          int    `json:"sampleRate"`
	Channels            int    `json:"channels"`
	TargetBitsPerSecond int    `json:"targetBitsPerSecond"`
}

func validSourceAudioOutput(a *sourceAudioEncodingSelection) bool {
	return a != nil && a.Codec == "aac" && a.SampleRate == 48000 && (a.Channels == 1 || a.Channels == 2) &&
		a.TargetBitsPerSecond >= 16000 && a.TargetBitsPerSecond <= 320000 && (a.Channels != 1 || a.TargetBitsPerSecond <= 192000)
}

func (a sourceProgramAssignment) outputAudioChannels() int {
	if a.AudioOutput != nil {
		return a.AudioOutput.Channels
	}
	return 2 // Explicit legacy v4 default, never a fallback for an invalid v5.
}

func (c sourceProgramEncoderConfig) outputAudioChannels() int {
	if c.audioChannels == 0 {
		return 2 // Existing local configurations remain byte-compatible.
	}
	return c.audioChannels
}
