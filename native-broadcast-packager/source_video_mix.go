package main

import (
	"errors"
	"math"
	"sync"
)

const sourceVideoMixMaxTime = math.MaxInt64 - 48000
const sourceVideoSceneMaxRevision = 1<<53 - 1

type sourceVideoMixConfig struct {
	width, height, maxSources, queueFrames, maxRGBABytes int
	startSample, lookAheadSamples                        int64
	authorized                                           func() bool
}

type sourceVideoMixInputConfig struct {
	width, height      int
	kind, fit          string // camera/screen; contain/cover.
	maxFrameAgeSamples int64  // Shared 48-kHz program clock, not arrival time.
	mapTimestamp       func(uint32) (int64, bool)
	timeline           sourceVideoTimeline // Exclusive with the fixed mapping adapter.
	authorized         func() bool
}

type sourceVideoMixFrame struct {
	pixels []byte
	at     int64
	used   bool
}

// Local decoded-image owner only. Clock/policy callbacks must be bounded,
// thread-safe and non-reentrant. The program clock schedules Render; the
// decoder must Close its exact input generation on revoke, even while idle.
type sourceVideoMixer struct {
	mu           sync.Mutex
	cfg          sourceVideoMixConfig
	sources      map[*sourceVideoMixInput]struct{}
	usedBytes    int
	output       []byte
	cursor       int64
	rendered     bool
	closed       bool
	programOwned bool
	revision     uint64
	layout       string
	scene        []*sourceVideoMixInput
	rects        []sourceVideoRect
}

type sourceVideoMixInput struct {
	fence     *sourceRenderFence
	mixer     *sourceVideoMixer
	cfg       sourceVideoMixInputConfig
	frames    []sourceVideoMixFrame
	pending   []int
	current   int
	last      int64
	started   bool
	closed    bool
	timeBound bool
	timeEpoch uint64
}

func validSourceVideoSize(width, height int) bool {
	return width >= 2 && width <= 1920 && height >= 2 && height <= 1080 && width%2 == 0 && height%2 == 0
}

func newSourceVideoMixer(cfg sourceVideoMixConfig) (*sourceVideoMixer, error) {
	if !validSourceVideoSize(cfg.width, cfg.height) || cfg.width < 32 || cfg.height < 20 || cfg.maxSources < 1 || cfg.maxSources > 80 ||
		cfg.queueFrames < 2 || cfg.queueFrames > 8 || cfg.maxRGBABytes < cfg.width*cfg.height*4 || cfg.maxRGBABytes > 256*1024*1024 ||
		cfg.startSample < 0 || cfg.startSample > sourceVideoMixMaxTime || cfg.lookAheadSamples < 960 || cfg.lookAheadSamples > 48000 ||
		cfg.authorized == nil || !cfg.authorized() {
		return nil, errors.New("source video mixer config denied")
	}
	output := make([]byte, cfg.width*cfg.height*4)
	return &sourceVideoMixer{cfg: cfg, sources: make(map[*sourceVideoMixInput]struct{}), output: output, usedBytes: len(output),
		cursor: cfg.startSample, revision: 1, layout: "waiting-slate"}, nil
}

func (m *sourceVideoMixer) Add(cfg sourceVideoMixInputConfig) (*sourceVideoMixInput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		return nil, errors.New("source video mixer closed")
	}
	if !validSourceVideoSize(cfg.width, cfg.height) || !oneOf(cfg.kind, "camera", "screen") || !oneOf(cfg.fit, "contain", "cover") ||
		cfg.maxFrameAgeSamples < 4800 || cfg.maxFrameAgeSamples > 1440000 || cfg.authorized == nil || (cfg.mapTimestamp == nil) == (cfg.timeline == nil) || !cfg.authorized() ||
		len(m.sources) >= m.cfg.maxSources || cfg.width*cfg.height*4*m.cfg.queueFrames > m.cfg.maxRGBABytes-m.usedBytes {
		return nil, errors.New("source video mixer admission denied")
	}
	s := &sourceVideoMixInput{mixer: m, cfg: cfg, fence: &sourceRenderFence{allowed: cfg.authorized}, current: -1,
		frames: make([]sourceVideoMixFrame, m.cfg.queueFrames), pending: make([]int, 0, m.cfg.queueFrames)}
	for i := range s.frames {
		s.frames[i].pixels = make([]byte, cfg.width*cfg.height*4)
		m.usedBytes += len(s.frames[i].pixels)
	}
	m.sources[s] = struct{}{}
	return s, nil
}

func (s *sourceVideoMixInput) WriteRGBA(width, height int, timestamp uint32, pixels []byte) error {
	m := s.mixer
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		return errors.New("source video mixer closed")
	}
	if s.closed || !s.cfg.authorized() || width != s.cfg.width || height != s.cfg.height || len(pixels) != s.cfg.width*s.cfg.height*4 {
		s.closeLocked()
		return errors.New("source video mixer input denied")
	}
	var at int64
	var ok bool
	if s.cfg.timeline != nil {
		var snapshot sourceVideoTime
		at, snapshot = s.cfg.timeline.MapVideo(timestamp)
		ok = s.acceptVideoTime(snapshot)
		if !ok && !s.closed {
			return nil
		}
	} else {
		at, ok = s.cfg.mapTimestamp(timestamp)
	}
	if !ok || at < 0 || at > sourceVideoMixMaxTime || (s.started && at <= s.last) || at > m.cursor+m.cfg.lookAheadSamples {
		s.closeLocked()
		return errors.New("source video mixer clock denied")
	}
	s.started, s.last = true, at
	if at < m.cursor && m.cursor-at >= s.cfg.maxFrameAgeSamples {
		return nil // Never shift a stale frame into the present.
	}
	slot := -1
	for i := range s.frames {
		if !s.frames[i].used {
			slot = i
			break
		}
	}
	if slot < 0 {
		// Preserve both the presented image and the next pending deadline.
		// Dropping the earliest future frame lets a continuous ahead-of-clock
		// producer evict every image before it is due: permanent slate/freeze.
		// Replace only the furthest pending image, or drop the new arrival if
		// the next deadline is our sole pending slot. The pool never grows.
		last := len(s.pending) - 1
		if last < 1 {
			return nil
		}
		slot = s.pending[last]
		s.pending[last] = 0
		s.pending = s.pending[:last]
		s.clearFrame(slot)
	}
	copy(s.frames[slot].pixels, pixels)
	s.frames[slot].at, s.frames[slot].used = at, true
	s.pending = append(s.pending, slot)
	return nil
}

// SetScene is a local CAS presentation operation, not source authorization.
// It never changes a program epoch, consent, lease or writer fence. A future
// control adapter must authenticate the director and bind this local owner.
func (m *sourceVideoMixer) SetScene(expected uint64, layout string, inputs []*sourceVideoMixInput, active *sourceVideoMixInput) (uint64, error) {
	return m.setSceneGuarded(expected, layout, inputs, active, nil)
}

func (m *sourceVideoMixer) setSceneGuarded(expected uint64, layout string, inputs []*sourceVideoMixInput, active *sourceVideoMixInput, current func() bool) (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		return m.revision, errors.New("source video mixer closed")
	}
	if expected != m.revision || m.revision >= sourceVideoSceneMaxRevision || len(inputs) > 20 ||
		(active != nil && layout != "single" && layout != "active-speaker") {
		return m.revision, errors.New("source video scene conflict")
	}
	kinds := make([]string, len(inputs))
	selected := -1
	seen := make(map[*sourceVideoMixInput]bool, len(inputs))
	for i, s := range inputs {
		if s == nil || s.mixer != m || s.closed || seen[s] {
			return m.revision, errors.New("source video scene input denied")
		}
		if _, ok := m.sources[s]; !ok {
			return m.revision, errors.New("source video scene input denied")
		}
		if !s.cfg.authorized() {
			s.closeLocked()
			return m.revision, errors.New("source video scene input denied")
		}
		seen[s], kinds[i] = true, s.cfg.kind
		if s == active {
			selected = i
		}
	}
	if active != nil && selected < 0 {
		return m.revision, errors.New("source video scene selection denied")
	}
	rects, err := sourceVideoSceneRects(layout, kinds, m.cfg.width, m.cfg.height, selected)
	if err != nil {
		return m.revision, err
	}
	// A command may have expired while waiting for the render mutex. A refused
	// presentation change must not tear down the running compositor.
	if current != nil && !current() {
		return m.revision, errors.New("source scene command expired")
	}
	m.scene, m.rects, m.layout = append([]*sourceVideoMixInput(nil), inputs...), rects, layout
	m.revision++
	return m.revision, nil
}

// Pixels are borrowed only for a bounded, nonblocking local handoff; never
// write an encoder pipe here. Close is serialized with this handoff and the
// output is wiped before return. Downstream queues need their own revocation.
func (m *sourceVideoMixer) Render(at int64, consume func(int64, uint64, []byte) error) error {
	if consume == nil {
		return m.RenderGuarded(at, nil)
	}
	return m.RenderGuarded(at, func(ts int64, rev uint64, pixels []byte, _ sourceRenderGuard) error { return consume(ts, rev, pixels) })
}

func (m *sourceVideoMixer) RenderGuarded(at int64, consume func(int64, uint64, []byte, sourceRenderGuard) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() || consume == nil || at < m.cursor || at > sourceVideoMixMaxTime || (m.rendered && at == m.cursor) {
		m.closeLocked()
		return errors.New("source video mixer output denied")
	}
	m.cursor, m.rendered = at, true
	defer clear(m.output)
	var guard sourceRenderGuard
	for s := range m.sources {
		if !s.cfg.authorized() {
			s.closeLocked()
			continue
		}
		if s.cfg.timeline != nil && !s.acceptVideoTime(s.cfg.timeline.VideoTime()) {
			continue
		}
		s.advance(at)
	}
	fillSourceVideoSlate(m.output, m.cfg.width, 0, 0, m.cfg.width, m.cfg.height)
	for _, rect := range m.rects {
		s := m.scene[rect.source]
		// Paint the whole tile even for overlays; unavailable sources must not
		// reveal a formerly selected frame or another source beneath the tile.
		fillSourceVideoSlate(m.output, m.cfg.width, rect.x, rect.y, rect.width, rect.height)
		if s != nil && !s.closed && s.current >= 0 {
			guard.add(s.fence)
			blitSourceVideo(m.output, m.cfg.width, rect, s.cfg.width, s.cfg.height, s.cfg.fit, s.frames[s.current].pixels)
		}
	}
	for _, s := range m.scene {
		if s != nil && !s.cfg.authorized() {
			s.closeLocked()
			// A lease may expire during the bounded pixel work. Discard the
			// composed image rather than hand off that source's old pixels.
			fillSourceVideoSlate(m.output, m.cfg.width, 0, 0, m.cfg.width, m.cfg.height)
		}
	}
	if !m.cfg.authorized() {
		m.closeLocked()
		return errors.New("source video mixer output denied")
	}
	if !guard.Valid() {
		fillSourceVideoSlate(m.output, m.cfg.width, 0, 0, m.cfg.width, m.cfg.height)
		guard = sourceRenderGuard{}
	}
	if err := consume(at, m.revision, m.output, guard); err != nil {
		m.closeLocked()
		return errors.New("source video mixer output failed")
	}
	return nil
}

func (s *sourceVideoMixInput) clearFrame(i int) {
	clear(s.frames[i].pixels)
	s.frames[i].used, s.frames[i].at = false, 0
}

func (s *sourceVideoMixInput) advance(at int64) {
	for len(s.pending) > 0 && s.frames[s.pending[0]].at <= at {
		if s.current >= 0 {
			s.clearFrame(s.current)
		}
		s.current = s.popPending()
	}
	if s.current >= 0 && at-s.frames[s.current].at >= s.cfg.maxFrameAgeSamples {
		s.clearFrame(s.current)
		s.current = -1
	}
}

func (s *sourceVideoMixInput) popPending() int {
	i := s.pending[0]
	copy(s.pending, s.pending[1:])
	s.pending[len(s.pending)-1] = 0
	s.pending = s.pending[:len(s.pending)-1]
	return i
}

func (s *sourceVideoMixInput) closeLocked() {
	if s.closed {
		return
	}
	s.closed = true
	s.fence.closed.Store(true)
	for i := range s.frames {
		s.clearFrame(i)
		s.mixer.usedBytes -= len(s.frames[i].pixels)
	}
	s.frames, s.pending, s.current = nil, nil, -1
	s.cfg.mapTimestamp, s.cfg.authorized = nil, nil
	s.cfg.timeline = nil
	for i, input := range s.mixer.scene {
		if input == s {
			s.mixer.scene[i] = nil
		}
	}
	delete(s.mixer.sources, s)
}

func (s *sourceVideoMixInput) Close() {
	s.mixer.mu.Lock()
	defer s.mixer.mu.Unlock()
	s.closeLocked()
}

func (m *sourceVideoMixer) closeLocked() {
	if m.closed {
		return
	}
	m.closed = true
	for s := range m.sources {
		s.closeLocked()
	}
	clear(m.output)
	m.output, m.scene, m.rects = nil, nil, nil
	m.usedBytes = 0
}

func (m *sourceVideoMixer) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeLocked()
}
