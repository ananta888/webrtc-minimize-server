package main

import (
	"io"
	"os/exec"
)

// OS adapters own only local FFmpeg input transport, never room authority.
type transcodeInputs struct {
	video, audio       io.WriteCloser
	videoURL, audioURL string
	configure          func(*exec.Cmd)
	started            func(*exec.Cmd)
	close              func()
}
