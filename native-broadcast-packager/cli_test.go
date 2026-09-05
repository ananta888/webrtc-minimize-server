package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Execute the real main dispatch in child processes. Only FFmpeg is synthetic;
// no network server, enrollment or production identity is involved.
func TestMain(m *testing.M) {
	if os.Getenv("PACKAGER_CLI_TEST_HELPER") == "1" {
		if len(os.Args) == 3 && os.Args[1] == "-hide_banner" {
			if os.Getenv("PACKAGER_CLI_TEST_BAD_FFMPEG") == "1" {
				fmt.Fprintln(os.Stderr, "fixture-secret-must-not-escape")
				os.Exit(1)
			}
			switch os.Args[2] {
			case "-version":
				fmt.Println("ffmpeg version 8.1.1")
			case "-encoders":
				fmt.Println(" V libx264 video\n A aac audio")
			default:
				os.Exit(2)
			}
			os.Exit(0)
		}
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestCLIRejectsUnknownCommandsBeforeSideEffects(t *testing.T) {
	for _, args := range [][]string{{"unknown"}, {"preflight", "extra"}, {"enroll", "extra"}, {"--help"}} {
		if _, err := commandMode(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	for _, args := range [][]string{nil, {"version"}, {"preflight"}, {"enroll"}, {"operator-manifest"}} {
		if _, err := commandMode(args); err != nil {
			t.Fatal(err)
		}
	}
	root := t.TempDir()
	output, err := runCLI(t, root, "unknown")
	if err == nil || !strings.Contains(output, "usage:") {
		t.Fatalf("unexpected command result: %q %v", output, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("unknown command created identity or output")
	}
}

func runCLI(t *testing.T, root, command string, extra ...string) (string, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, command)
	cmd.Env = append(os.Environ(), "PACKAGER_CLI_TEST_HELPER=1",
		"NATIVE_PACKAGER_CONTROL_URL=wss://127.0.0.1:1/native-packager",
		"NATIVE_PACKAGER_ID=pkr_0123456789abcdef",
		"NATIVE_PACKAGER_IDENTITY_FILE="+filepath.Join(root, "identity.pem"),
		"NATIVE_PACKAGER_OUTPUT_ROOT="+filepath.Join(root, "output"),
		"NATIVE_PACKAGER_FFMPEG="+executable, "NATIVE_PACKAGER_ENROLLMENT_TOKEN=",
	)
	cmd.Env = append(cmd.Env, extra...)
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("CLI exceeded deadline (unexpected connection or hang): %s", output)
	}
	return string(output), err
}

func TestCLIPreflightPreservesIdentityAndMediaWithoutConnecting(t *testing.T) {
	root := t.TempDir()
	keyPath := filepath.Join(root, "identity.pem")
	if _, err := loadOrCreateIdentity(keyPath); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	resource := filepath.Join(root, "output", "res_0123456789abcdef")
	if err := os.MkdirAll(resource, 0o700); err != nil {
		t.Fatal(err)
	}
	media := filepath.Join(resource, "master.m3u8")
	if err := os.WriteFile(media, []byte("preserve-media"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"0", "1"} {
		output, err := runCLI(t, root, "preflight", "PACKAGER_CLI_TEST_BAD_FFMPEG="+bad)
		if bad == "0" {
			var report preflightReport
			if err != nil || json.Unmarshal([]byte(output), &report) != nil || report != localPreflightReport() {
				t.Fatalf("unexpected preflight: %q %v", output, err)
			}
		} else if err == nil || !strings.Contains(output, "ffmpeg version probe failed") || strings.Contains(output, "fixture-secret") {
			t.Fatalf("unsafe failure: %q %v", output, err)
		}
		after, err := os.ReadFile(keyPath)
		if err != nil || string(before) != string(after) {
			t.Fatal("preflight changed identity")
		}
		data, err := os.ReadFile(media)
		if err != nil || string(data) != "preserve-media" {
			t.Fatal("preflight cleaned media")
		}
	}
}

func TestCLIPreflightNeverCreatesMissingIdentity(t *testing.T) {
	root := t.TempDir()
	output, err := runCLI(t, root, "preflight")
	if err == nil || !strings.Contains(output, "identity unavailable") {
		t.Fatalf("missing identity accepted: %q", output)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("preflight created identity or output")
	}
	keyPath := filepath.Join(root, "identity.pem")
	if err := os.WriteFile(keyPath, []byte("invalid-private-fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err = runCLI(t, root, "preflight")
	if err == nil || strings.Contains(output, "invalid-private-fixture") {
		t.Fatal("corrupt key accepted or exposed")
	}
	data, err := os.ReadFile(keyPath)
	if err != nil || string(data) != "invalid-private-fixture" {
		t.Fatal("corrupt identity was replaced")
	}
}

func TestCLIVersionDoesNotRequireConfiguration(t *testing.T) {
	root := t.TempDir()
	output, err := runCLI(t, root, "version", "NATIVE_PACKAGER_CONTROL_URL=invalid")
	if err != nil || !strings.Contains(output, "native-packager-build") {
		t.Fatalf("version unavailable: %q %v", output, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("version touched identity/output")
	}
}
