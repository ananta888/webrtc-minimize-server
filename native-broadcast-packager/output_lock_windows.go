package main

import (
	"errors"
	"os"
	"os/exec"

	"golang.org/x/sys/windows"
)

func lockOutputFile(file *os.File) error {
	err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return errOutputBusy
	}
	return err
}

// Windows encoders are contained by the agent's kill-on-close Job Object.
// Unlike flock, Windows byte-range locks must not be treated as inherited.
func inheritOutputLock(_ *exec.Cmd, _ *os.File) {}
