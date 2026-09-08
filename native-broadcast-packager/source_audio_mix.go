package main

import (
	"encoding/binary"
	"errors"
	"math"
	"sync"
)

const sourceAudioMixSamples = 960 // One 20-ms stereo block at 48 kHz.
const sourceAudioMixMaxTime = math.MaxInt64 - 48000

type sourceAudioMixConfig struct {
	maxSources, queueSamples, maxPCMBytes int
	startSample                           int64
	authorized                            func() bool
}

type sourceAudioMixInputConfig struct {
	// Maps the publication's RTP clock to the shared 48-kHz program clock.
	// No arrival-time fallback: missing/invalid clock correspondence denies input.
	mapTimestamp func(uint32) (int64, bool)
	authorized   func() bool
	left, right  int // Q15 gain, 0..32768, independently for each channel.
}

// This stage owns decoded PCM only, not capture, clock synchronization, source
// authority, codecs, encoder processes or writer ownership. Policy and clock
// callbacks must be bounded, thread-safe and may not reenter this stage.
type sourceAudioMixer struct {
	mu       sync.Mutex
	cfg      sourceAudioMixConfig
	sources  map[*sourceAudioMixInput]struct{}
	pcmBytes int
	cursor   int64
	closed   bool
	sum      [sourceAudioMixSamples * 2]int64
	output   [sourceAudioMixSamples * 4]byte
}

// Implements sourceAudioOutput; the decoder must Close this exact generation
// on revocation, including when idle. A new generation requires a new handle.
type sourceAudioMixInput struct {
	mixer   *sourceAudioMixer
	cfg     sourceAudioMixInputConfig
	pcm     []int16
	lastEnd int64
	started bool
	closed  bool
}

func newSourceAudioMixer(cfg sourceAudioMixConfig) (*sourceAudioMixer, error) {
	if cfg.maxSources < 1 || cfg.maxSources > 80 || cfg.queueSamples < sourceAudioMixSamples ||
		cfg.queueSamples > 48000 || cfg.queueSamples%120 != 0 || cfg.maxPCMBytes < cfg.queueSamples*4 ||
		cfg.maxPCMBytes > 80*48000*4 || cfg.startSample < 0 || cfg.startSample > sourceAudioMixMaxTime ||
		cfg.authorized == nil || !cfg.authorized() {
		return nil, errors.New("source audio mixer config denied")
	}
	return &sourceAudioMixer{cfg: cfg, sources: make(map[*sourceAudioMixInput]struct{}), cursor: cfg.startSample}, nil
}

func validSourceAudioGain(left, right int) bool {
	return left >= 0 && left <= 32768 && right >= 0 && right <= 32768
}

func (m *sourceAudioMixer) Add(cfg sourceAudioMixInputConfig) (*sourceAudioMixInput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		return nil, errors.New("source audio mixer closed")
	}
	if cfg.mapTimestamp == nil || cfg.authorized == nil || !cfg.authorized() || !validSourceAudioGain(cfg.left, cfg.right) ||
		len(m.sources) >= m.cfg.maxSources || m.pcmBytes+m.cfg.queueSamples*4 > m.cfg.maxPCMBytes {
		return nil, errors.New("source audio mixer admission denied")
	}
	s := &sourceAudioMixInput{mixer: m, cfg: cfg, pcm: make([]int16, m.cfg.queueSamples*2)}
	m.sources[s] = struct{}{}
	m.pcmBytes += m.cfg.queueSamples * 4
	return s, nil
}

func (s *sourceAudioMixInput) WritePCM(rate, channels int, timestamp uint32, pcm []byte) error {
	m := s.mixer
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		return errors.New("source audio mixer closed")
	}
	if s.closed || !s.cfg.authorized() || rate != 48000 || channels != 2 || len(pcm) == 0 || len(pcm)%4 != 0 || len(pcm) > 5760*4 {
		s.closeLocked()
		return errors.New("source audio mixer input denied")
	}
	start, ok := s.cfg.mapTimestamp(timestamp)
	samples := int64(len(pcm) / 4)
	if !ok || start < 0 || start > sourceAudioMixMaxTime || (s.started && start < s.lastEnd) ||
		start+samples > m.cursor+int64(m.cfg.queueSamples) {
		s.closeLocked()
		return errors.New("source audio mixer clock or queue denied")
	}
	s.started, s.lastEnd = true, start+samples
	// Already-played samples are discarded, never shifted into the present.
	for i := max(start, m.cursor); i < start+samples; i++ {
		src := int(i-start) * 4
		dst := int(i%int64(m.cfg.queueSamples)) * 2
		s.pcm[dst] = int16(binary.LittleEndian.Uint16(pcm[src:]))
		s.pcm[dst+1] = int16(binary.LittleEndian.Uint16(pcm[src+2:]))
	}
	return nil
}

func (s *sourceAudioMixInput) SetGain(left, right int) error {
	m := s.mixer
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		return errors.New("source audio mixer closed")
	}
	if s.closed || !s.cfg.authorized() {
		s.closeLocked()
		return errors.New("source audio mixer source closed")
	}
	if !validSourceAudioGain(left, right) {
		return errors.New("source audio mixer gain denied")
	}
	s.cfg.left, s.cfg.right = left, right
	return nil
}

// Render consumes exactly the next program block, including silence for missing
// samples. The clock owner schedules calls; this stage does not infer real time.
// consume must be a bounded nonblocking local handoff, never encoder/pipe I/O.
// PCM is borrowed only during the callback and wiped before Render returns.
// Close is serialized with that handoff. A later writer queue needs its own
// generation/fence revocation; bytes already handed off cannot be recalled.
func (m *sourceAudioMixer) Render(consume func(int64, []byte) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() || consume == nil || m.cursor > sourceAudioMixMaxTime-sourceAudioMixSamples {
		m.closeLocked()
		return errors.New("source audio mixer output denied")
	}
	defer clear(m.sum[:])
	defer clear(m.output[:])
	for s := range m.sources {
		if !s.cfg.authorized() {
			s.closeLocked()
			continue
		}
		for i := 0; i < sourceAudioMixSamples; i++ {
			index := int((m.cursor+int64(i))%int64(m.cfg.queueSamples)) * 2
			m.sum[i*2] += int64(s.pcm[index]) * int64(s.cfg.left)
			m.sum[i*2+1] += int64(s.pcm[index+1]) * int64(s.cfg.right)
			s.pcm[index], s.pcm[index+1] = 0, 0
		}
	}
	for i, value := range m.sum {
		// Sum at full precision, then attenuate and saturate once: independent
		// of source iteration order, with no gain change when a peer leaves.
		value = max(-32768, min(32767, value/32768))
		binary.LittleEndian.PutUint16(m.output[i*2:], uint16(int16(value)))
	}
	if !m.cfg.authorized() {
		m.closeLocked()
		return errors.New("source audio mixer output denied")
	}
	if err := consume(m.cursor, m.output[:]); err != nil {
		m.closeLocked()
		return errors.New("source audio mixer output failed")
	}
	m.cursor += sourceAudioMixSamples
	return nil
}

func (s *sourceAudioMixInput) closeLocked() {
	if s.closed {
		return
	}
	s.closed = true
	clear(s.pcm)
	s.pcm = nil
	s.cfg.mapTimestamp, s.cfg.authorized = nil, nil
	delete(s.mixer.sources, s)
	s.mixer.pcmBytes -= s.mixer.cfg.queueSamples * 4
}

func (s *sourceAudioMixInput) Close() {
	s.mixer.mu.Lock()
	defer s.mixer.mu.Unlock()
	s.closeLocked()
}

func (m *sourceAudioMixer) closeLocked() {
	if m.closed {
		return
	}
	m.closed = true
	for s := range m.sources {
		s.closeLocked()
	}
	clear(m.sum[:])
	clear(m.output[:])
}

func (m *sourceAudioMixer) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeLocked()
}
