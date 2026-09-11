package main

import (
	"errors"
	"os"
	"strings"
)

var errMediaUnavailable = errors.New("broadcast media unavailable")

func openMediaDirectory(parent *os.File, name string) (*os.File, error) {
	return openMediaEntry(parent, name, true)
}

// Every name is one canonical component; the kernel rejects symlinks at the
// same operation which opens it. No check-then-follow window or inode cache.
func openMediaEntry(parent *os.File, name string, directory bool) (*os.File, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return nil, errMediaUnavailable
	}
	file, err := openMediaAt(parent, name, directory)
	if err != nil {
		return nil, errMediaUnavailable
	}
	actual, err := file.Stat()
	if err != nil || directory && !actual.IsDir() || !directory &&
		(!actual.Mode().IsRegular() || actual.Size() < 0 || actual.Size() > maximumMediaFileBytes) {
		_ = file.Close()
		return nil, errMediaUnavailable
	}
	return file, nil
}

func (value *origin) openMedia(parts []string) (*os.File, error) {
	if len(parts) != 2 && len(parts) != 3 {
		return nil, errMediaUnavailable
	}
	resource, err := openMediaDirectory(value.directory, parts[0])
	if err != nil {
		return nil, err
	}
	defer resource.Close()
	directory := resource
	if len(parts) == 3 {
		directory, err = openMediaDirectory(resource, parts[1])
		if err != nil {
			return nil, err
		}
		defer directory.Close()
	}
	return openMediaEntry(directory, parts[len(parts)-1], false)
}
