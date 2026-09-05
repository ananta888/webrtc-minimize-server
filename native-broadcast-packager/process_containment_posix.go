//go:build !windows

package main

// POSIX launchers/containers and the bounded pipeline retain their own lifecycle.
func initializeProcessContainment() error { return nil }
