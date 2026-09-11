//go:build linux

package main

import (
	"os"
	"syscall"
)

const supportedMediaFilesystem = true

func openMediaAt(parent *os.File, name string, directory bool) (*os.File, error) {
	raw, err := parent.SyscallConn()
	if err != nil {
		return nil, err
	}
	flags := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
	if directory {
		flags |= syscall.O_DIRECTORY
	}
	var fd int
	var openErr error
	// Control keeps the parent descriptor alive across openat, including Close.
	err = raw.Control(func(parentFD uintptr) {
		for {
			fd, openErr = syscall.Openat(int(parentFD), name, flags, 0)
			if openErr != syscall.EINTR {
				break
			}
		}
	})
	if err != nil {
		return nil, err
	}
	if openErr != nil {
		return nil, openErr
	}
	return os.NewFile(uintptr(fd), name), nil
}
