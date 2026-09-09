package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var sourceHLSSegment = regexp.MustCompile(`^segment_[0-9]{1,12}\.m4s$`)
var sourceHLSNumber = regexp.MustCompile(`^[0-9]{1,12}$`)

type sourceHLSPlaylist struct {
	data   []byte
	media  []string
	window sourceHLSWindow
}
type sourceHLSWindow struct{ first, last uint64 }
type sourceHLSPublished struct {
	info   os.FileInfo
	source os.FileInfo
	seen   uint64
}

// One owned private staging tree; only exact profile files can be committed.
// Not a generic HLS proxy/parser. The producer is our fixed local FFmpeg profile.
type sourceHLSStage struct {
	mu          sync.Mutex
	owner       *outputOwnership
	fence       *sourceEncoderFence
	profile     assignmentProfile
	epoch       sourceHLSEpoch
	pending     string
	directories map[string]os.FileInfo
	published   map[string]sourceHLSPublished
	windows     map[string]sourceHLSWindow
	last        string
	cycle       uint64
	maxBytes    int64
	closed      bool
	copyBuffer  [32768]byte
}

func newSourceHLSStage(owner *outputOwnership, fence *sourceEncoderFence, profile assignmentProfile, maxBytes int64) (*sourceHLSStage, error) {
	return newSourceHLSStageWithEpoch(owner, fence, profile, maxBytes, 0)
}

func newSourceHLSStageWithEpoch(owner *outputOwnership, fence *sourceEncoderFence, profile assignmentProfile, maxBytes int64, epoch sourceHLSEpoch) (*sourceHLSStage, error) {
	if !epoch.valid() {
		return nil, errors.New("source HLS generation budget")
	}
	if owner == nil || fence == nil || !fence.Valid() || len(profile.Renditions) < 1 || len(profile.Renditions) > 3 || maxBytes < 1 || maxBytes > 128*1024*1024 {
		return nil, errors.New("source HLS stage config")
	}
	s := &sourceHLSStage{owner: owner, fence: fence, profile: profile, epoch: epoch, pending: filepath.Join(owner.output, ".pending"), maxBytes: maxBytes,
		directories: map[string]os.FileInfo{"": owner.info}, published: make(map[string]sourceHLSPublished), windows: make(map[string]sourceHLSWindow)}
	s.profile.Renditions = append([]assignmentRendition(nil), profile.Renditions...)
	paths := []string{".pending"}
	seen := map[string]bool{}
	for _, r := range profile.Renditions {
		if !oneOf(r.ID, "low", "medium", "high") || seen[r.ID] {
			return nil, errors.New("source HLS stage rendition")
		}
		seen[r.ID] = true
		paths = append(paths, r.ID, filepath.Join(".pending", r.ID))
	}
	for _, relative := range paths {
		path := filepath.Join(owner.output, relative)
		if err := os.Mkdir(path, 0700); err != nil {
			return nil, errors.New("source HLS stage directory")
		}
		info, err := os.Lstat(path)
		if err != nil {
			return nil, errors.New("source HLS stage directory")
		}
		s.directories[relative] = info
	}
	return s, nil
}

func (s *sourceHLSStage) safeDirectory(relative string) bool {
	for _, path := range []string{"", relative} {
		expected := s.directories[path]
		if expected == nil {
			return false
		}
		actual, err := os.Lstat(filepath.Join(s.owner.output, path))
		if err != nil || !actual.IsDir() || actual.Mode()&os.ModeSymlink != 0 || !os.SameFile(expected, actual) {
			return false
		}
	}
	return true
}

func sourceHLSParsePlaylist(data []byte, init string) (sourceHLSPlaylist, error) {
	bad := errors.New("source HLS playlist shape")
	if len(data) < 8 || len(data) > 65536 || !strings.HasPrefix(string(data), "#EXTM3U\n") || strings.ContainsAny(string(data), "\x00\r") {
		return sourceHLSPlaylist{}, bad
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(lines) > 64 {
		return sourceHLSPlaylist{}, bad
	}
	result := sourceHLSPlaylist{data: data, media: []string{init}}
	seen := map[string]bool{}
	durationPending := false
	maps := 0
	for _, line := range lines {
		switch {
		case line == "#EXTM3U", line == "#EXT-X-INDEPENDENT-SEGMENTS", line == "#EXT-X-ENDLIST":
		case strings.HasPrefix(line, "#EXT-X-VERSION:"), strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"), strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			parts := strings.SplitN(line, ":", 2)
			if seen[parts[0]] || !sourceHLSNumber.MatchString(parts[1]) {
				return sourceHLSPlaylist{}, bad
			}
			seen[parts[0]] = true
		case line == `#EXT-X-MAP:URI="`+init+`"`:
			maps++
		case strings.HasPrefix(line, "#EXTINF:"):
			value := strings.TrimSuffix(strings.TrimPrefix(line, "#EXTINF:"), ",")
			duration, err := strconv.ParseFloat(value, 64)
			if err != nil || !(duration > 0 && duration <= 12) || !strings.HasSuffix(line, ",") || durationPending {
				return sourceHLSPlaylist{}, bad
			}
			durationPending = true
		case strings.HasPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:"):
			// Date metadata is not a URI; keep its alphabet closed and bounded.
			value := strings.TrimPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:")
			if len(value) < 20 || len(value) > 40 || strings.Trim(value, "0123456789T:.-+Z") != "" {
				return sourceHLSPlaylist{}, bad
			}
		case sourceHLSSegment.MatchString(line):
			if !durationPending || seen[line] || len(result.media) >= 8 {
				return sourceHLSPlaylist{}, bad
			}
			seen[line] = true
			durationPending = false
			result.media = append(result.media, line)
		default:
			return sourceHLSPlaylist{}, bad
		}
	}
	if maps != 1 || durationPending || len(result.media) < 2 || !seen["#EXT-X-MEDIA-SEQUENCE"] || !seen["#EXT-X-TARGETDURATION"] {
		return sourceHLSPlaylist{}, bad
	}
	return result, nil
}

func (s *sourceHLSStage) readPlaylist(id, init string) (sourceHLSPlaylist, error) {
	dir := filepath.Join(".pending", id)
	if !s.safeDirectory(".pending") || !s.safeDirectory(dir) {
		return sourceHLSPlaylist{}, errors.New("source HLS private directory changed")
	}
	path := filepath.Join(s.owner.output, dir, "index.m3u8")
	info, err := os.Lstat(path)
	if err != nil {
		return sourceHLSPlaylist{}, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 65536 {
		return sourceHLSPlaylist{}, errors.New("source HLS playlist size")
	}
	file, err := os.Open(path)
	if err != nil {
		return sourceHLSPlaylist{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return sourceHLSPlaylist{}, errors.New("source HLS playlist changed")
	}
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil {
		return sourceHLSPlaylist{}, err
	}
	return s.epoch.playlist(data, init)
}

func (s *sourceHLSStage) fileBytes() int64 {
	var sum int64
	for _, p := range s.published {
		sum += p.info.Size()
	}
	return sum
}

// Called only after the filename allowlist. FFmpeg can rename a completed
// temporary or delete an expired segment after enumeration but before Info.
// A missing referenced object still fails later in copyMedia.
func sourceHLSInventoryInfo(entry os.DirEntry) (os.FileInfo, error) {
	info, err := entry.Info()
	if os.IsNotExist(err) {
		return nil, nil
	}
	return info, err
}

// Bound even unpublished FFmpeg output, not just files referenced by playlists.
// The fixed producer may create only known variants, objects and their .tmp.
func (s *sourceHLSStage) inventory() error {
	var total int64
	count := 0
	inspect := func(dir string, allowed func(string) bool) error {
		if !s.safeDirectory(dir) {
			return errors.New("source HLS inventory directory")
		}
		file, err := os.Open(filepath.Join(s.owner.output, dir))
		if err != nil {
			return err
		}
		defer file.Close()
		entries, err := file.ReadDir(65)
		if err != nil && err != io.EOF {
			return err
		}
		if len(entries) > 64 {
			return errors.New("source HLS inventory count")
		}
		for _, entry := range entries {
			count++
			if count > 64 || !allowed(entry.Name()) {
				return errors.New("source HLS inventory path")
			}
			info, err := sourceHLSInventoryInfo(entry)
			if err != nil {
				return err
			}
			if info == nil {
				continue
			}
			if info.IsDir() {
				if dir != ".pending" || !oneOf(entry.Name(), "low", "medium", "high") {
					return errors.New("source HLS inventory object type")
				}
				continue
			}
			if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > 24*1024*1024 {
				return errors.New("source HLS inventory file")
			}
			total += info.Size()
			if total > s.maxBytes {
				return errors.New("source HLS private byte budget")
			}
		}
		return nil
	}
	if err := inspect(".pending", func(name string) bool {
		if name == "index.m3u8" || name == "index.m3u8.tmp" {
			return true
		}
		for _, r := range s.profile.Renditions {
			if name == r.ID {
				return true
			}
		}
		return false
	}); err != nil {
		return err
	}
	for i, r := range s.profile.Renditions {
		init := renditionInitFilename(len(s.profile.Renditions), i)
		if err := inspect(filepath.Join(".pending", r.ID), func(name string) bool {
			name = strings.TrimSuffix(name, ".tmp")
			return name == "index.m3u8" || name == init || sourceHLSSegment.MatchString(name)
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *sourceHLSStage) commit(relative string, source io.Reader, size int64) error {
	if s.closed || !s.fence.Valid() || size < 1 || size > 24*1024*1024 || len(s.published) >= 64 {
		return errors.New("source HLS commit denied")
	}
	dir := filepath.Dir(relative)
	if dir == "." {
		dir = ""
	}
	if !s.safeDirectory(dir) || !s.safeDirectory(".pending") {
		return errors.New("source HLS output directory changed")
	}
	destination := filepath.Join(s.owner.output, relative)
	current, statErr := os.Lstat(destination)
	old, known := s.published[relative]
	if statErr == nil && (!known || !current.Mode().IsRegular() || !os.SameFile(old.info, current)) || statErr != nil && !os.IsNotExist(statErr) {
		return errors.New("source HLS output ownership changed")
	}
	previous := int64(0)
	if known {
		previous = old.info.Size()
	}
	if s.fileBytes()-previous+size > s.maxBytes {
		return errors.New("source HLS output byte budget")
	}
	file, err := os.CreateTemp(s.pending, ".publish-")
	if err != nil {
		return errors.New("source HLS commit unavailable")
	}
	name := file.Name()
	defer os.Remove(name)
	defer file.Close()
	n, err := io.CopyBuffer(file, io.LimitReader(source, size+1), s.copyBuffer[:])
	if err != nil || n != size {
		return errors.New("source HLS copy changed")
	}
	if err = file.Close(); err != nil {
		return errors.New("source HLS commit close")
	}
	if !s.fence.Valid() || !s.safeDirectory(dir) || !s.safeDirectory(".pending") {
		return errors.New("source HLS commit revoked")
	}
	if err = os.Rename(name, destination); err != nil {
		return errors.New("source HLS commit rename")
	}
	info, err := os.Lstat(destination)
	if err != nil {
		return errors.New("source HLS commit stat")
	}
	s.published[relative] = sourceHLSPublished{info: info, seen: s.cycle}
	if !s.fence.Valid() {
		return errors.New("source HLS commit revoked")
	}
	return nil
}

func (s *sourceHLSStage) copyMedia(id, name string) error {
	relative := filepath.Join(id, name)
	path := filepath.Join(s.pending, relative)
	if old, ok := s.published[relative]; ok {
		current, err := os.Lstat(path)
		if err != nil || old.source == nil || !current.Mode().IsRegular() || !os.SameFile(old.source, current) || current.Size() != old.source.Size() || !current.ModTime().Equal(old.source.ModTime()) {
			return errors.New("source HLS immutable media changed")
		}
		old.seen = s.cycle
		s.published[relative] = old
		return nil
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 24*1024*1024 {
		return errors.New("source HLS media shape")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return errors.New("source HLS media changed")
	}
	if err := s.commit(relative, file, info.Size()); err != nil {
		return err
	}
	published := s.published[relative]
	published.source = info
	s.published[relative] = published
	return nil
}

// Serial filesystem worker only. Callers must stop the encoder on an error.
// False/nil means a normal not-yet-ready output, not a successful live program.
func (s *sourceHLSStage) Publish() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.fence.Valid() {
		return false, errors.New("source HLS publish revoked")
	}
	if err := s.inventory(); err != nil {
		return false, err
	}
	plans := make([]sourceHLSPlaylist, len(s.profile.Renditions))
	key := ""
	for i, r := range s.profile.Renditions {
		p, err := s.readPlaylist(r.ID, renditionInitFilename(len(plans), i))
		if os.IsNotExist(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if previous, ok := s.windows[r.ID]; ok && (p.window.first < previous.first || p.window.last < previous.last) {
			return false, errors.New("source HLS timeline rollback")
		}
		plans[i] = p
		key += string(p.data)
	}
	if key == s.last {
		return true, nil
	}
	s.cycle++
	// All referenced objects before any playlist; never serve FFmpeg's .tmp.
	for i, r := range s.profile.Renditions {
		for _, name := range plans[i].media {
			if err := s.copyMedia(r.ID, name); err != nil {
				return false, err
			}
		}
	}
	master := "#EXTM3U\n#EXT-X-VERSION:7\n"
	for i, r := range s.profile.Renditions {
		if err := s.commit(filepath.Join(r.ID, "index.m3u8"), strings.NewReader(string(plans[i].data)), int64(len(plans[i].data))); err != nil {
			return false, err
		}
		master += fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n%s/index.m3u8\n", (r.VideoBitsPerSecond+r.AudioBitsPerSecond)*115/100, r.Width, r.Height, r.ID)
	}
	if err := s.commit("index.m3u8", strings.NewReader(master), int64(len(master))); err != nil {
		return false, err
	}
	s.last = key
	for i, r := range s.profile.Renditions {
		s.windows[r.ID] = plans[i].window
	}
	for relative, p := range s.published {
		if p.seen+2 < s.cycle {
			if err := s.remove(relative, p); err != nil {
				return false, err
			}
			delete(s.published, relative)
		}
	}
	return true, nil
}

func (s *sourceHLSStage) remove(relative string, p sourceHLSPublished) error {
	dir := filepath.Dir(relative)
	if dir == "." {
		dir = ""
	}
	if !s.safeDirectory(dir) {
		return errors.New("source HLS removal directory changed")
	}
	path := filepath.Join(s.owner.output, relative)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, p.info) {
		return errors.New("source HLS removal ownership changed")
	}
	return os.Remove(path)
}

func (s *sourceHLSStage) Invalidate() error {
	s.fence.Revoke() // invalidate first; filesystem cleanup may wait on copying
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	var result error
	for relative, p := range s.published {
		if err := s.remove(relative, p); err != nil {
			result = err
		} else {
			delete(s.published, relative)
		}
	}
	s.last = ""
	clear(s.copyBuffer[:])
	return result
}
