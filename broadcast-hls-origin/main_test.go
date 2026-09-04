package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func testOrigin(t *testing.T) (*origin, string) {
	t.Helper()
	root := t.TempDir()
	resource := "res_0123456789abcdef"
	if err := os.Mkdir(filepath.Join(root, resource), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, resource, "index.m3u8"), []byte("#EXTM3U\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := newOrigin(root)
	if err != nil {
		t.Fatal(err)
	}
	return value, resource
}

func request(value *origin, method, path, authorization string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", authorization)
	value.ServeHTTP(recorder, req)
	return recorder
}

func TestOriginServesOnlyAuthorizedExactMediaPaths(t *testing.T) {
	value, resource := testOrigin(t)
	response := request(value, http.MethodGet, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token")
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/vnd.apple.mpegurl" || response.Body.String() != "#EXTM3U\n" {
		t.Fatalf("unexpected origin response: code=%d type=%s body=%q", response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "private, no-store, max-age=0" {
		t.Fatal("origin response is cacheable")
	}
	for _, path := range []string{
		"/" + resource + "/index.m3u8?token=secret",
		"/" + resource + "/../identity.pem",
		"/res_ffffffffffffffff/unknown.m3u8",
		"/" + resource + "/nested/index.m3u8",
	} {
		if rejected := request(value, http.MethodGet, path, "Bearer synthetic-test-token"); rejected.Code != http.StatusNotFound {
			t.Fatalf("unsafe path accepted: %s (%d)", path, rejected.Code)
		}
	}
	if response := request(value, http.MethodGet, "/"+resource+"/index.m3u8", ""); response.Code != http.StatusNotFound {
		t.Fatal("origin accepted a request without a bearer boundary")
	}
}

func TestOriginRejectsSymlinksAndSupportsBoundedRanges(t *testing.T) {
	value, resource := testOrigin(t)
	outside := filepath.Join(t.TempDir(), "secret.mp4")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(value.root, resource, "low_init.mp4")); err != nil {
		t.Fatal(err)
	}
	if response := request(value, http.MethodGet, "/"+resource+"/low_init.mp4", "Bearer synthetic-test-token"); response.Code != http.StatusNotFound {
		t.Fatal("origin followed a media symlink")
	}
	req := httptest.NewRequest(http.MethodGet, "/"+resource+"/index.m3u8", nil)
	req.Header.Set("Authorization", "Bearer synthetic-test-token")
	req.Header.Set("Range", "bytes=0-3")
	recorder := httptest.NewRecorder()
	value.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusPartialContent || recorder.Body.String() != "#EXT" {
		t.Fatalf("bounded range failed: code=%d body=%q", recorder.Code, recorder.Body.String())
	}
}

func TestHealthDoesNotExposeMedia(t *testing.T) {
	value, _ := testOrigin(t)
	if response := request(value, http.MethodGet, "/healthz", ""); response.Code != http.StatusNoContent {
		t.Fatalf("health failed: %d", response.Code)
	}
}
