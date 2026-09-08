package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
)

// Private process ownership only. Callers supply fixed local codec profiles,
// never source-controlled commands, URLs or policy. Reaping follows worker exit.
type sourceDecodeProcess struct {
	cmd    *exec.Cmd
	input  io.WriteCloser
	output io.ReadCloser
}

func startSourceDecodeProcess(path string, args []string) (*sourceDecodeProcess, error) {
	cmd := exec.Command(path, args...)
	setSourceCodecEnvironment(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, errors.New("source decoder input unavailable")
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return nil, errors.New("source decoder output unavailable")
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		return nil, errors.New("source decoder unavailable")
	}
	return &sourceDecodeProcess{cmd: cmd, input: input, output: output}, nil
}

func setSourceCodecEnvironment(cmd *exec.Cmd) {
	cmd.Env = []string{}
	// A codec subprocess does not need control-plane credentials or operator
	// application secrets. Keep only OS/loader paths required by local FFmpeg.
	for _, name := range []string{"PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"} {
		if value, ok := os.LookupEnv(name); ok {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
}

func (p *sourceDecodeProcess) stop() {
	_ = p.input.Close()
	_ = p.output.Close()
	_ = p.cmd.Process.Kill()
}
