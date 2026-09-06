package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const outputTestOwner = "pkr_aaaaaaaaaaaaaaaa"
const outputTestOther = "pkr_bbbbbbbbbbbbbbbb"
const outputTestResource = "res_0123456789abcdef"

func TestOutputOwnershipPreservesLiveAndForeignWriters(t *testing.T) {
	root := t.TempDir()
	owned, err := acquireOutputOwnership(root, outputTestResource, outputTestOwner)
	if err != nil {
		t.Fatal(err)
	}
	defer owned.close()
	media := filepath.Join(owned.output, "index.m3u8")
	if err = os.WriteFile(media, []byte("synthetic media"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, owner := range []string{outputTestOwner, outputTestOther} {
		if err = cleanOutputRoot(root, owner); err != nil {
			t.Fatal(err)
		}
		if other, err := acquireOutputOwnership(root, outputTestResource, owner); err == nil {
			_ = other.close()
			t.Fatal("second writer acquired live output")
		}
		if value, err := os.ReadFile(media); err != nil || string(value) != "synthetic media" {
			t.Fatal("live output was modified")
		}
	}
	_ = owned.file.Close() // Simulate a crashed process without graceful cleanup.
	if err = cleanOutputRoot(root, outputTestOther); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(media); err != nil {
		t.Fatal("foreign orphan was removed")
	}
	if err = cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(owned.output); !os.IsNotExist(err) {
		t.Fatal("own orphan was not reclaimed")
	}
	newOwner, err := acquireOutputOwnership(root, outputTestResource, outputTestOther)
	if err != nil {
		t.Fatal(err)
	}
	defer newOwner.close()
	_ = owned.close()
	if _, err = os.Stat(newOwner.output); err != nil {
		t.Fatal("old cleanup removed the new generation")
	}
}

func TestOutputOwnershipCleansOnlyItsCurrentDirectory(t *testing.T) {
	root := t.TempDir()
	owned, err := acquireOutputOwnership(root, outputTestResource, outputTestOwner)
	if err != nil {
		t.Fatal(err)
	}
	if err = owned.close(); err != nil {
		t.Fatal(err)
	}
	if err = owned.close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(owned.output); !os.IsNotExist(err) {
		t.Fatal("owned output survived close")
	}
	owned, err = acquireOutputOwnership(root, outputTestResource, outputTestOwner)
	if err != nil {
		t.Fatal(err)
	}
	// An unexpected marker mutation must never authorize cleanup of its content.
	if _, err = owned.file.WriteAt([]byte("!"), 0); err != nil {
		t.Fatal(err)
	}
	if err = owned.close(); err == nil {
		t.Fatal("changed ownership accepted")
	}
	if _, err = os.Stat(owned.output); err != nil {
		t.Fatal("changed output was deleted")
	}
	if err = cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(owned.output); err != nil {
		t.Fatal("corrupt ownership marker was deleted")
	}
}

func TestOutputOwnershipAllowsIndependentResourcesInSharedRoot(t *testing.T) {
	root := t.TempDir()
	first, err := acquireOutputOwnership(root, outputTestResource, outputTestOwner)
	if err != nil {
		t.Fatal(err)
	}
	defer first.close()
	second, err := acquireOutputOwnership(root, "res_fedcba9876543210", outputTestOther)
	if err != nil {
		t.Fatal(err)
	}
	defer second.close()
	if err = cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if err = cleanOutputRoot(root, outputTestOther); err != nil {
		t.Fatal(err)
	}
	if err = first.close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(second.output); err != nil {
		t.Fatal("closing one writer removed another resource")
	}
	if err = second.close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || entries[0].Name() != ".native-packager-output.lock" {
		t.Fatal("resource or ownership file survived terminal cleanup")
	}
}

func TestOutputOwnershipRejectsResourceSymlink(t *testing.T) {
	root, target := t.TempDir(), t.TempDir()
	if err := os.Symlink(target, filepath.Join(root, outputTestResource)); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if owned, err := acquireOutputOwnership(root, outputTestResource, outputTestOwner); err == nil {
		_ = owned.close()
		t.Fatal("resource symlink accepted")
	}
	if err := cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(target); err != nil || len(entries) != 0 {
		t.Fatal("symlink target modified")
	}
}

func TestOutputOwnershipHelper(t *testing.T) {
	if os.Getenv("PACKAGER_OUTPUT_HELPER") == "inherited-v1" {
		file := os.NewFile(3, "inherited-output-lock")
		if file == nil {
			os.Exit(24)
		}
		defer file.Close()
		if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() {
			os.Exit(24)
		}
		fmt.Println("inherited")
		_, _ = bufio.NewReader(os.Stdin).ReadByte()
		return
	}
	if os.Getenv("PACKAGER_OUTPUT_HELPER") != "claim-v1" {
		return
	}
	owned, err := acquireOutputOwnership(os.Getenv("PACKAGER_OUTPUT_TEST_ROOT"), outputTestResource, outputTestOwner)
	if err != nil {
		os.Exit(23)
	}
	fmt.Println("owned")
	_, _ = bufio.NewReader(os.Stdin).ReadByte()
	_ = owned.close()
}

func TestOutputOwnershipProcessCrashAndExclusivity(t *testing.T) {
	root := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestOutputOwnershipHelper$")
	cmd.Env = append(os.Environ(), "PACKAGER_OUTPUT_HELPER=claim-v1", "PACKAGER_OUTPUT_TEST_ROOT="+root)
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
	if err != nil || line != "owned\n" {
		t.Fatal("child failed to acquire output")
	}
	if owned, err := acquireOutputOwnership(root, outputTestResource, outputTestOwner); err == nil {
		_ = owned.close()
		t.Fatal("separate process did not fence the second writer")
	}
	if err = cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, outputTestResource)); err != nil {
		t.Fatal("startup removed live child output")
	}
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	if err = cleanOutputRoot(root, outputTestOwner); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, outputTestResource)); !os.IsNotExist(err) {
		t.Fatal("dead writer output not reclaimed")
	}
}
