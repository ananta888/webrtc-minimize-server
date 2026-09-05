package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsJobHelper(t *testing.T) {
	role := os.Getenv("PACKAGER_JOB_TEST_ROLE")
	if role == "" {
		return
	}
	if role == "agent" {
		if err := initializeProcessContainment(); err != nil {
			t.Fatal(err)
		}
		executable, _ := os.Executable()
		child := exec.Command(executable, "-test.run=^TestWindowsJobHelper$")
		child.Env = append(os.Environ(), "PACKAGER_JOB_TEST_ROLE=child")
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv("PACKAGER_JOB_TEST_MARKER"), []byte(fmt.Sprint(child.Process.Pid)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(time.Minute)
}

func TestWindowsJobKillsOnlyAgentDescendantsOnAbruptExit(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "child.pid")
	start := func(role string) *exec.Cmd {
		cmd := exec.Command(executable, "-test.run=^TestWindowsJobHelper$")
		cmd.Env = append(os.Environ(), "PACKAGER_JOB_TEST_ROLE="+role, "PACKAGER_JOB_TEST_MARKER="+marker)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd
	}
	unrelated := start("child")
	agent := start("agent")
	var childPID int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if value, err := os.ReadFile(marker); err == nil {
			childPID, _ = strconv.Atoi(string(value))
			if childPID > 0 {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if childPID == 0 {
		t.Fatal("contained child did not start")
	}
	child, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(childPID))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(child)
	defer windows.TerminateProcess(child, 1)
	other, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(unrelated.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(other)
	if err := agent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if state, err := windows.WaitForSingleObject(child, 3000); err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatalf("agent left its child running: state=%d error=%v", state, err)
	}
	if state, err := windows.WaitForSingleObject(other, 0); err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("unrelated process did not survive: state=%d error=%v", state, err)
	}
}
