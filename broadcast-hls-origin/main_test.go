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
	t.Cleanup(value.Close)
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
	if err := os.Mkdir(filepath.Join(value.root, resource, "low"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(value.root, resource, "low", "index.m3u8"), []byte("#EXTM3U\n#EXT-X-MAP:URI=\"init_0.mp4\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(value.root, resource, "low", "init_0.mp4"), []byte("synthetic-init"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(value.root, resource, "low", "init.mp4"), []byte("synthetic-single-init"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(value.root, resource, "captions_live.vtt"), []byte("WEBVTT\n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := request(value, http.MethodGet, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token")
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/vnd.apple.mpegurl" || response.Body.String() != "#EXTM3U\n" {
		t.Fatalf("unexpected origin response: code=%d type=%s body=%q", response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "private, no-store, max-age=0" {
		t.Fatal("origin response is cacheable")
	}
	nestedManifest := request(value, http.MethodGet, "/"+resource+"/low/index.m3u8", "Bearer synthetic-test-token")
	if nestedManifest.Code != http.StatusOK || nestedManifest.Header().Get("Content-Type") != "application/vnd.apple.mpegurl" {
		t.Fatalf("nested rendition manifest unavailable: code=%d type=%s", nestedManifest.Code, nestedManifest.Header().Get("Content-Type"))
	}
	nestedInit := request(value, http.MethodGet, "/"+resource+"/low/init_0.mp4", "Bearer synthetic-test-token")
	if nestedInit.Code != http.StatusOK || nestedInit.Header().Get("Content-Type") != "video/mp4" || nestedInit.Body.String() != "synthetic-init" {
		t.Fatalf("nested rendition init unavailable: code=%d type=%s body=%q", nestedInit.Code, nestedInit.Header().Get("Content-Type"), nestedInit.Body.String())
	}
	singleInit := request(value, http.MethodGet, "/"+resource+"/low/init.mp4", "Bearer synthetic-test-token")
	if singleInit.Code != http.StatusOK || singleInit.Body.String() != "synthetic-single-init" {
		t.Fatalf("single-rendition init unavailable: code=%d body=%q", singleInit.Code, singleInit.Body.String())
	}
	caption := request(value, http.MethodGet, "/"+resource+"/captions_live.vtt", "Bearer synthetic-test-token")
	if caption.Code != http.StatusOK || caption.Header().Get("Content-Type") != "text/vtt; charset=utf-8" {
		t.Fatalf("caption output unavailable: code=%d type=%s", caption.Code, caption.Header().Get("Content-Type"))
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
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(value.root, resource, "medium")); err != nil {
		t.Fatal(err)
	}
	if response := request(value, http.MethodGet, "/"+resource+"/medium/init_1.mp4", "Bearer synthetic-test-token"); response.Code != http.StatusNotFound {
		t.Fatal("origin followed a rendition-directory symlink")
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

func TestOriginPinsConfiguredRootAcrossPathReplacement(t *testing.T) {
	value, resource := testOrigin(t)
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, resource), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, resource, "index.m3u8"), []byte("outside-original-root"), 0600); err != nil {
		t.Fatal(err)
	}
	moved := value.root + "-moved"
	if err := os.Rename(value.root, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(value.root); err != nil {
			t.Error(err)
		}
		if err := os.Rename(moved, value.root); err != nil {
			t.Error(err)
		}
	})
	if err := os.Symlink(outside, value.root); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := request(value, method, "/"+resource+"/index.m3u8", "Bearer synthetic-test-token")
		if response.Code != http.StatusOK {
			t.Fatalf("pinned original unavailable: %s %d", method, response.Code)
		}
		if method == http.MethodGet && response.Body.String() != "#EXTM3U\n" {
			t.Fatal("origin escaped original directory through replaced root path")
		}
	}
}

func TestOriginRequiresWholeFilenameMatchEvenForExistingFiles(t *testing.T) {
	value, resource := testOrigin(t)
	for _, name := range []string{"index.m3u8.pending.m3u8", "low_init.mp4.backup.mp4", "index.mp4.pending.vtt", "prefixcaptions_live.vtt", ".pendingcaptions_live.vtt"} {
		if err := os.WriteFile(filepath.Join(value.root, resource, name), []byte("synthetic uncommitted artifact"), 0600); err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			response := request(value, method, "/"+resource+"/"+name, "Bearer synthetic-test-token")
			if response.Code != http.StatusNotFound {
				t.Errorf("noncanonical existing file accepted: %s %s (%d)", method, name, response.Code)
			}
		}
	}
	for _, name := range []string{"index.m3u8", "low.m3u8", "medium_init.mp4", "high_segment_123456789012.m4s", "captions_live.vtt"} {
		if err := os.WriteFile(filepath.Join(value.root, resource, name), []byte("synthetic published artifact"), 0600); err != nil {
			t.Fatal(err)
		}
		if response := request(value, http.MethodGet, "/"+resource+"/"+name, "Bearer synthetic-test-token"); response.Code != http.StatusOK {
			t.Errorf("canonical file rejected: %s (%d)", name, response.Code)
		}
	}
	if err := os.MkdirAll(filepath.Join(value.root, resource, ".pending", "low"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(value.root, resource, ".pending", "low", "index.m3u8"), []byte("synthetic pending playlist"), 0600); err != nil {
		t.Fatal(err)
	}
	if response := request(value, http.MethodGet, "/"+resource+"/.pending/low/index.m3u8", "Bearer synthetic-test-token"); response.Code != http.StatusNotFound {
		t.Fatal("private staging path was exposed")
	}
}
