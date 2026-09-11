package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestOriginRejectsRootSymlinkAtStartupAndClosedDirectory(t *testing.T) {
	value, resource := testOrigin(t)
	link := filepath.Join(t.TempDir(), "root-link")
	if err := os.Symlink(value.root, link); err != nil {
		t.Fatal(err)
	}
	if opened, err := newOrigin(link); err == nil {
		opened.Close()
		t.Fatal("symlink root accepted")
	}
	value.Close()
	value.Close()
	if response := request(value, http.MethodGet, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token"); response.Code != http.StatusNotFound {
		t.Fatal("closed directory still serves new requests")
	}
}

func TestAtomicOpenAllowsRegularReplacementButRejectsLinkWithinSameResource(t *testing.T) {
	value, resource := testOrigin(t)
	directory, err := openMediaDirectory(value.directory, resource)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	for _, symlink := range []bool{false, true} {
		base := filepath.Join(value.root, resource)
		if err := os.WriteFile(filepath.Join(base, "replacement"), []byte("replacement"), 0600); err != nil {
			t.Fatal(err)
		}
		if symlink {
			if err := os.Remove(filepath.Join(base, "index.m3u8")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("replacement", filepath.Join(base, "index.m3u8")); err != nil {
				t.Fatal(err)
			}
		} else if err := os.Rename(filepath.Join(base, "replacement"), filepath.Join(base, "index.m3u8")); err != nil {
			t.Fatal(err)
		}
		file, err := openMediaEntry(directory, "index.m3u8", false)
		if file != nil {
			file.Close()
		}
		if symlink && err == nil {
			t.Fatal("link to another inode accepted")
		}
		if !symlink && err != nil {
			t.Fatal("legitimate atomic publication rejected")
		}
	}
}

func TestResourceDirectoryCannotAliasAnotherProgram(t *testing.T) {
	value, resource := testOrigin(t)
	other := "res_aaaaaaaaaaaaaaaa"
	if err := os.Mkdir(filepath.Join(value.root, other), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(value.root, other, "index.m3u8"), []byte("other-program"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(value.root, resource), filepath.Join(value.root, "moved")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(value.root, resource)); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		if response := request(value, method, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token"); response.Code != http.StatusNotFound {
			t.Fatal("resource alias exposed another program")
		}
	}
}

func TestPinnedResourceSurvivesRenameWithoutFollowingReplacement(t *testing.T) {
	value, resource := testOrigin(t)
	directory, err := openMediaDirectory(value.directory, resource)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := os.Rename(filepath.Join(value.root, resource), filepath.Join(value.root, "moved")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(value.root, resource)); err != nil {
		t.Fatal(err)
	}
	file, err := openMediaEntry(directory, "index.m3u8", false)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	body, err := io.ReadAll(file)
	if err != nil || string(body) != "#EXTM3U\n" {
		t.Fatal("pinned resource changed after rename")
	}
	for _, name := range []string{"", ".", "..", "../index.m3u8", "/index.m3u8", "low/index.m3u8", "low\\index.m3u8", "bad\x00name"} {
		if file, err := openMediaEntry(directory, name, false); err == nil {
			file.Close()
			t.Fatal("non-component accepted")
		}
	}
}

func TestOriginRootedFilesOverRealHTTP(t *testing.T) {
	value, resource := testOrigin(t)
	server := httptest.NewServer(value)
	t.Cleanup(server.Close)
	client := server.Client()
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req, err := http.NewRequest(method, server.URL+"/"+resource+"/index.m3u8", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer synthetic-test-token")
		req.Header.Set("Range", "bytes=0-3")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusPartialContent || response.Header.Get("Cache-Control") != "private, no-store, max-age=0" {
			t.Fatal("rooted HTTP range response failed")
		}
		if method == http.MethodGet && string(body) != "#EXT" || method == http.MethodHead && len(body) != 0 {
			t.Fatal("rooted HTTP GET/HEAD body differs")
		}
	}
}

func TestOriginConcurrentReplacementNeverReturnsOutsideBytes(t *testing.T) {
	value, resource := testOrigin(t)
	outside := filepath.Join(t.TempDir(), "index.m3u8")
	if err := os.WriteFile(outside, []byte("outside-root"), 0600); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(value.root, resource)
	done := make(chan error, 1)
	go func() {
		for n := 0; n < 300; n++ {
			stage := filepath.Join(base, "replacement")
			if err := os.Symlink(outside, stage); err != nil {
				done <- err
				return
			}
			if err := os.Rename(stage, filepath.Join(base, "index.m3u8")); err != nil {
				done <- err
				return
			}
			if err := os.WriteFile(stage, []byte("#EXTM3U\n"), 0600); err != nil {
				done <- err
				return
			}
			if err := os.Rename(stage, filepath.Join(base, "index.m3u8")); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	var failure error
	for n := 0; n < 600; n++ {
		response := request(value, http.MethodGet, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token")
		if response.Code != http.StatusNotFound && (response.Code != http.StatusOK || response.Body.String() != "#EXTM3U\n") {
			failure = fmt.Errorf("unexpected response across replacement: %d", response.Code)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if failure != nil {
		t.Fatal(failure)
	}
}
