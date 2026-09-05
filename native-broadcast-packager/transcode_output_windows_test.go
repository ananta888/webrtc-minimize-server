package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A directory junction needs no symbolic-link privilege. Exercise the actual
// Windows reparse-point guard without enabling Developer Mode or elevation.
func TestOutputCleanupRejectsWindowsRootJunction(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	resource := filepath.Join(target, "res_0123456789abcdef")
	if err := os.MkdirAll(resource, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "junction")
	command := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
		"New-Item -ItemType Junction -Path $env:PACKAGER_TEST_LINK -Value $env:PACKAGER_TEST_TARGET -ErrorAction Stop | Out-Null")
	command.Env = append(os.Environ(), "PACKAGER_TEST_LINK="+link, "PACKAGER_TEST_TARGET="+target)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("test junction creation failed: %v: %s", err, output)
	}
	if err := cleanOutputRoot(link); err == nil {
		t.Fatal("cleanup followed a Windows directory junction")
	}
	if _, err := os.Stat(resource); err != nil {
		t.Fatal("cleanup touched the junction target")
	}
}
