package main

import (
	"context"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const maximumMediaFileBytes = 24 * 1024 * 1024

var resourcePattern = regexp.MustCompile(`^res_[A-Za-z0-9_-]{16,64}$`)
var rootMediaFilePattern = regexp.MustCompile(`^(?:index|(?:low|medium|high)(?:_init|_segment_[0-9]{1,12})?)\.(?:m3u8|mp4|m4s)|(?:captions_[A-Za-z0-9_-]{1,48})\.vtt$`)
var renditionMediaFilePattern = regexp.MustCompile(`^(?:low|medium|high)/(?:index\.m3u8|init(?:_[0-2])?\.mp4|segment_[0-9]{1,12}\.m4s)$`)

type origin struct {
	root string
}

func newOrigin(root string) (*origin, error) {
	if !filepath.IsAbs(root) || strings.ContainsAny(root, "\x00\r\n") {
		return nil, errors.New("BROADCAST_ORIGIN_ROOT must be absolute")
	}
	clean := filepath.Clean(root)
	info, err := os.Stat(clean)
	if err != nil || !info.IsDir() {
		return nil, errors.New("broadcast origin root unavailable")
	}
	return &origin{root: clean}, nil
}

func (value *origin) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "private, no-store, max-age=0")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	if request.URL.Path == "/healthz" && request.Method == http.MethodGet && request.URL.RawQuery == "" {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if (request.Method != http.MethodGet && request.Method != http.MethodHead) || request.URL.RawQuery != "" {
		http.NotFound(response, request)
		return
	}
	authorization := request.Header.Get("Authorization")
	if len(authorization) < 16 || len(authorization) > 8192 || !strings.HasPrefix(authorization, "Bearer ") {
		http.NotFound(response, request)
		return
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, "/"), "/")
	if (len(parts) != 2 && len(parts) != 3) || !resourcePattern.MatchString(parts[0]) {
		http.NotFound(response, request)
		return
	}
	relativeMediaPath := strings.Join(parts[1:], "/")
	if (len(parts) == 2 && !rootMediaFilePattern.MatchString(relativeMediaPath)) ||
		(len(parts) == 3 && !renditionMediaFilePattern.MatchString(relativeMediaPath)) {
		http.NotFound(response, request)
		return
	}
	resourceDirectory := filepath.Join(value.root, parts[0])
	filename := filepath.Join(append([]string{resourceDirectory}, parts[1:]...)...)
	relative, err := filepath.Rel(resourceDirectory, filename)
	if err != nil || filepath.Dir(resourceDirectory) != value.root || filepath.ToSlash(relative) != relativeMediaPath {
		http.NotFound(response, request)
		return
	}
	candidates := []string{resourceDirectory}
	if len(parts) == 3 {
		candidates = append(candidates, filepath.Join(resourceDirectory, parts[1]))
	}
	candidates = append(candidates, filename)
	for _, candidate := range candidates {
		info, err := os.Lstat(candidate)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			http.NotFound(response, request)
			return
		}
	}
	file, err := os.Open(filename)
	if err != nil {
		http.NotFound(response, request)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maximumMediaFileBytes {
		http.NotFound(response, request)
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(filename))
	switch filepath.Ext(filename) {
	case ".m3u8":
		contentType = "application/vnd.apple.mpegurl"
	case ".m4s", ".mp4":
		contentType = "video/mp4"
	case ".vtt":
		contentType = "text/vtt; charset=utf-8"
	default:
		http.NotFound(response, request)
		return
	}
	response.Header().Set("Content-Type", contentType)
	http.ServeContent(response, request, parts[1], info.ModTime(), io.NewSectionReader(file, 0, info.Size()))
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://127.0.0.1:8081/healthz")
		if err != nil || response.StatusCode != http.StatusNoContent {
			os.Exit(1)
		}
		_ = response.Body.Close()
		return
	}
	if len(os.Args) != 1 {
		log.Fatal("usage: broadcast-hls-origin [healthcheck]")
	}
	value, err := newOrigin(os.Getenv("BROADCAST_ORIGIN_ROOT"))
	if err != nil {
		log.Fatal(err)
	}
	address := strings.TrimSpace(os.Getenv("BROADCAST_ORIGIN_ADDRESS"))
	if address == "" {
		address = ":8081"
	}
	server := &http.Server{
		Addr: address, Handler: value, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024,
		ErrorLog: log.New(io.Discard, "", 0),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("broadcast origin unavailable")
	}
}
