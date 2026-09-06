//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"

	"golang.org/x/sys/unix"
)

func lockOutputFile(file *os.File) error {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return errOutputBusy
	}
	return err
}

// flock follows the open-file description. Keep it alive in the encoder even
// when its parent agent is killed before the process supervisor can reap it.
func inheritOutputLock(cmd *exec.Cmd, file *os.File) { cmd.ExtraFiles = append(cmd.ExtraFiles, file) }
