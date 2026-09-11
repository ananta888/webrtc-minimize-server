//go:build !linux

package main

import "os"

// The origin is shipped in a Linux container. Unsupported filesystem platforms
// do not silently substitute an unbounded/unconfined file-opening path.
const supportedMediaFilesystem = false

func openMediaAt(_ *os.File, _ string, _ bool) (*os.File, error) {
	return nil, errMediaUnavailable
}
