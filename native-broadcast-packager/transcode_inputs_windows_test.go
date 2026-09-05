package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func TestWindowsMediaPipeRejectsWrongPIDBeforeWritingHeaders(t *testing.T) {
	pipe, name, err := newWindowsMediaPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer pipe.Close()
	if !strings.HasPrefix(name, `\\.\pipe\ananta-packager-`) {
		t.Fatal("input is not a local pipe")
	}
	if _, err := pipe.Write([]byte("synthetic-container-header")); err != nil {
		t.Fatal(err)
	}
	failed := make(chan struct{}, 1)
	pipe.start(os.Getpid()+1, time.Second, func() { failed <- struct{}{} })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, err := winio.DialPipeContext(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	data, _ := io.ReadAll(client)
	if len(data) != 0 {
		t.Fatal("wrong process received media bytes")
	}
	select {
	case <-failed:
	case <-time.After(time.Second):
		t.Fatal("wrong process did not fail closed")
	}
	if _, err := pipe.Write([]byte("frame")); err == nil {
		t.Fatal("failed input accepted data")
	}
}

func TestWindowsMediaPipeAcceptsBoundProcessAndClosesCleanly(t *testing.T) {
	pipe, name, err := newWindowsMediaPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer pipe.Close()
	header := []byte("synthetic-header")
	_, _ = pipe.Write(header)
	failed := make(chan struct{}, 1)
	pipe.start(os.Getpid(), time.Second, func() { failed <- struct{}{} })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, err := winio.DialPipeContext(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	actual := make([]byte, len(header))
	if _, err := io.ReadFull(client, actual); err != nil || !bytes.Equal(actual, header) {
		t.Fatalf("header unavailable: %v", err)
	}
	pipe.mu.Lock()
	server := pipe.conn.(interface{ Fd() uintptr })
	pipe.mu.Unlock()
	descriptor, err := windows.GetSecurityInfo(windows.Handle(server.Fd()), windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sddl := descriptor.String()
	if !strings.Contains(sddl, "D:P") || strings.Count(sddl, "(A;") != 1 || !strings.Contains(sddl, ";;;"+user.User.Sid.String()+")") {
		t.Fatal("local pipe ACL is not restricted to the current user")
	}
	if _, err := pipe.Write([]byte("frame")); err != nil {
		t.Fatal(err)
	}
	actual = make([]byte, 5)
	if _, err := io.ReadFull(client, actual); err != nil || string(actual) != "frame" {
		t.Fatalf("frame unavailable: %v", err)
	}
	_ = pipe.Close()
	if _, err := pipe.Write([]byte("late")); err == nil {
		t.Fatal("closed input accepted data")
	}
	select {
	case <-failed:
		t.Fatal("authorized input failed")
	default:
	}
}

func TestWindowsMediaPipeBoundsBlockedWrites(t *testing.T) {
	pipe, name, err := newWindowsMediaPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer pipe.Close()
	pipe.start(os.Getpid(), time.Second, func() {})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, err := winio.DialPipeContext(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	// Deliberately do not read: kernel buffers must not become an unbounded wait.
	result := make(chan error, 1)
	go func() { _, err := pipe.Write(make([]byte, 1024*1024)); result <- err }()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("blocked pipe write unexpectedly completed")
		}
	case <-time.After(localPipeWriteTimeout + 2*time.Second):
		t.Fatal("write deadline was not enforced")
	}
}

func TestWindowsMediaPipeBoundsHeadersConnectAndCancellation(t *testing.T) {
	for _, cancelEarly := range []bool{false, true} {
		pipe, _, err := newWindowsMediaPipe()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pipe.Write(make([]byte, 4097)); err == nil {
			t.Fatal("unbounded header accepted")
		}
		pipe.start(os.Getpid(), 50*time.Millisecond, func() {})
		done := make(chan error, 1)
		go func() { _, err := pipe.Write([]byte("frame")); done <- err }()
		if cancelEarly {
			_ = pipe.Close()
		}
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("missing client accepted media")
			}
		case <-time.After(time.Second):
			t.Fatal("unbounded input wait")
		}
		_ = pipe.Close()
	}
}
