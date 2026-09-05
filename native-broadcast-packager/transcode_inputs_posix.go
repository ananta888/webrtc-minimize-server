//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
)

func newTranscodeInputs(hasVideo, hasAudio bool) (*transcodeInputs, error) {
	inputs := &transcodeInputs{}
	var readers, writers []*os.File
	closeFiles := func(files []*os.File) {
		for _, file := range files {
			_ = file.Close()
		}
	}
	inputs.close = func() { closeFiles(readers); closeFiles(writers) }
	add := func() (*os.File, string, error) {
		reader, writer, err := os.Pipe()
		if err != nil {
			return nil, "", err
		}
		readers = append(readers, reader)
		writers = append(writers, writer)
		return writer, fmt.Sprintf("pipe:%d", len(readers)+2), nil
	}
	var err error
	if hasVideo {
		inputs.video, inputs.videoURL, err = add()
	}
	if err == nil && hasAudio {
		inputs.audio, inputs.audioURL, err = add()
	}
	if err != nil {
		inputs.close()
		return nil, err
	}
	inputs.configure = func(cmd *exec.Cmd) { cmd.ExtraFiles = readers }
	inputs.started = func(*exec.Cmd) { closeFiles(readers) }
	return inputs, nil
}
