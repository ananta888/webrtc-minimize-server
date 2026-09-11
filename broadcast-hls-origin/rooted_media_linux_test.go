//go:build linux

package main

import (
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestRegularFileReplacedByFIFODoesNotBlock(t *testing.T) {
	value, resource := testOrigin(t)
	directory, err := openMediaDirectory(value.directory, resource)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	filename := filepath.Join(value.root, resource, "index.m3u8")
	if err := os.Remove(filename); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filename, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan bool, 1)
	go func() {
		file, err := openMediaEntry(directory, "index.m3u8", false)
		if file != nil {
			file.Close()
		}
		done <- err != nil
	}()
	select {
	case rejected := <-done:
		if !rejected {
			t.Fatal("FIFO accepted as regular media")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("file substitution blocked on FIFO")
	}
}

func TestOriginClosesPerRequestDescriptors(t *testing.T) {
	value, resource := testOrigin(t)
	count := func() int {
		entries, err := os.ReadDir("/proc/self/fd")
		if err != nil {
			t.Fatal(err)
		}
		return len(entries)
	}
	// Warm MIME internals before taking the descriptor baseline.
	request(value, http.MethodGet, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token")
	before := count()
	for n := 0; n < 200; n++ {
		request(value, http.MethodGet, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token")
		request(value, http.MethodGet, "/"+resource+"/low/index.m3u8", "Bearer synthetic-test-token")
	}
	if after := count(); after != before {
		t.Fatalf("descriptor count changed: before=%d after=%d", before, after)
	}
	value.Close()
	if after := count(); after != before-1 {
		t.Fatalf("pinned root descriptor retained: before=%d after=%d", before, after)
	}
}

func TestOriginRejectsOversizeOpenedFileAndKeepsExactLimit(t *testing.T) {
	value, resource := testOrigin(t)
	file, err := os.OpenFile(filepath.Join(value.root, resource, "index.m3u8"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for _, size := range []int64{maximumMediaFileBytes + 1, maximumMediaFileBytes} {
		if err := file.Truncate(size); err != nil {
			t.Fatal(err)
		}
		response := request(value, http.MethodHead, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token")
		expected := http.StatusOK
		if size > maximumMediaFileBytes {
			expected = http.StatusNotFound
		}
		if response.Code != expected {
			t.Fatalf("opened file size=%d returned=%d", size, response.Code)
		}
	}
}
