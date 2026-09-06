//go:build !windows

package main

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestOutputLockRemainsHeldByEncoderChildAfterParentHandleCloses(t *testing.T) {
	root := t.TempDir()
	owned, err := acquireOutputOwnership(root, outputTestResource, outputTestOwner)
	if err != nil {
		t.Fatal(err)
	}
	defer owned.close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestOutputOwnershipHelper$")
	cmd.Env = append(os.Environ(), "PACKAGER_OUTPUT_HELPER=inherited-v1")
	inheritOutputLock(cmd, owned.file)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "inherited\n" {
		t.Fatal("encoder child did not inherit the lock handle")
	}
	_ = owned.file.Close()
	if err = cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, outputTestResource)); err != nil {
		t.Fatal("parent exit released a still-active encoder output")
	}
	if other, err := acquireOutputOwnership(root, outputTestResource, outputTestOwner); err == nil {
		_ = other.close()
		t.Fatal("old encoder lost exclusivity")
	}
	_ = stdin.Close()
	if err = cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if err = cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(owned.output); !os.IsNotExist(err) {
		t.Fatal("finished encoder output was not reclaimed")
	}
}
