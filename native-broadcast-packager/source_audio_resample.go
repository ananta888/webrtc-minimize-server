package main

import (
	"encoding/binary"
	"errors"
	"math"
	"sync"
)

const (
	sourceResampleTaps     = 128
	sourceResamplePhases   = 256
	sourceResampleCapacity = 5760 + sourceResampleTaps*2
)

// Immutable shared coefficients, not peer state. Blackman-windowed sinc,
// cutoff .45 cycles/input sample; phase interpolation avoids table quantization
// becoming an audible time-varying error. The supported ratio is .95..1.05.
var sourceResampleKernel = func() [sourceResamplePhases + 1][sourceResampleTaps]float64 {
	var table [sourceResamplePhases + 1][sourceResampleTaps]float64
	for phase := range table {
		fraction := float64(phase) / sourceResamplePhases
		var sum float64
		for j := range table[phase] {
			d := float64(j-63) - fraction
			if math.Abs(d) >= 64 {
				continue
			}
			sinc := .9
			if d != 0 {
				sinc = math.Sin(math.Pi*.9*d) / (math.Pi * d)
			}
			window := .42 + .5*math.Cos(math.Pi*d/64) + .08*math.Cos(2*math.Pi*d/64)
			table[phase][j] = sinc * window
			sum += table[phase][j]
		}
		for j := range table[phase] {
			table[phase][j] /= sum
		}
	}
	return table
}()

type sourceProgramAudioOutput interface {
	WriteProgramPCM(startSample int64, pcm []byte) error
	Close()
}

type sourceAudioResampleConfig struct {
	timing     func(uint32) (sourceAudioTiming, bool)
	authorized func() bool
}

// Owned by one decoder generation. Its owner must Close it on idle revocation,
// too. Policy/timing/output calls must be bounded and must not reenter it.
type sourceAudioResampler struct {
	mu                               sync.Mutex
	cfg                              sourceAudioResampleConfig
	sink                             sourceProgramAudioOutput
	buffer                           [sourceResampleCapacity * 2]int16
	output                           [sourceAudioMixSamples * 4]byte
	base, inputStart, cursor         int64
	count, outputCount, lastSize     int
	last                             uint32
	position, ratio                  float64
	seen, started, hasOutput, closed bool
}

func newSourceAudioResampler(cfg sourceAudioResampleConfig, sink sourceProgramAudioOutput) (*sourceAudioResampler, error) {
	if cfg.timing == nil || cfg.authorized == nil || sink == nil || !cfg.authorized() {
		return nil, errors.New("source resampler config denied")
	}
	return &sourceAudioResampler{cfg: cfg, sink: sink}, nil
}

func validSourceAudioTiming(t sourceAudioTiming) bool {
	return !math.IsNaN(t.sample) && !math.IsInf(t.sample, 0) && t.sample >= 0 && t.sample < 1<<52 &&
		!math.IsNaN(t.step) && t.step >= .95 && t.step <= 1.05
}

func (s *sourceAudioResampler) WritePCM(rate, channels int, timestamp uint32, pcm []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("source resampler closed")
	}
	if !s.cfg.authorized() || rate != 48000 || channels != 2 || len(pcm) == 0 || len(pcm)%4 != 0 || len(pcm) > 5760*4 {
		return s.failLocked()
	}
	samples := len(pcm) / 4
	gap := false
	if s.seen {
		delta := int64(int32(timestamp - s.last))
		if delta < int64(s.lastSize) || delta > 48000*12 || s.inputStart+delta >= 1<<52 {
			return s.failLocked()
		}
		s.inputStart += delta
		gap = delta != int64(s.lastSize)
	}
	s.seen, s.last, s.lastSize = true, timestamp, samples
	timing, ready := s.cfg.timing(timestamp)
	if !ready {
		s.clearBufferLocked()
		return nil // No invented arrival-time mapping or retained undecidable PCM.
	}
	if !validSourceAudioTiming(timing) {
		return s.failLocked()
	}
	if gap && s.started {
		// Finish only the old real samples, with zero right padding. The gap
		// itself stays absent; the program mixer supplies silence on its ticks.
		if err := s.renderLocked(float64(s.base + int64(s.count))); err != nil {
			return err
		}
		s.clearBufferLocked()
	}
	if !s.started {
		cursor := int64(math.Ceil(timing.sample))
		if s.hasOutput && float64(s.cursor)-timing.sample > 4800 {
			return s.failLocked()
		}
		if s.hasOutput {
			cursor = max(cursor, s.cursor)
		}
		s.cursor, s.ratio = cursor, timing.step
		s.position = float64(s.inputStart) + (float64(cursor)-timing.sample)/timing.step
		s.base, s.started = s.inputStart, true
	} else {
		phaseError := timing.sample + (s.position-float64(s.inputStart))*timing.step - float64(s.cursor)
		if math.Abs(phaseError) > 4800 {
			return s.failLocked()
		}
		// Correct phase over one second, with a bounded rate slew. Cursor
		// remains continuous; a new report cannot rewrite prior output time.
		desired := math.Max(.95, math.Min(1.05, timing.step+phaseError/48000))
		slew := float64(samples) / 48000 * .05
		s.ratio += math.Max(-slew, math.Min(slew, desired-s.ratio))
	}
	if s.count+samples > sourceResampleCapacity || s.base+int64(s.count) != s.inputStart {
		return s.failLocked()
	}
	for i := 0; i < samples*2; i++ {
		s.buffer[s.count*2+i] = int16(binary.LittleEndian.Uint16(pcm[i*2:]))
	}
	s.count += samples
	if err := s.renderLocked(float64(s.base + int64(s.count) - 64)); err != nil {
		return err
	}
	keep := max(s.base, int64(math.Floor(s.position))-63)
	keep = min(keep, s.base+int64(s.count))
	drop := int(keep - s.base)
	s.count -= drop
	copy(s.buffer[:], s.buffer[drop*2:(drop+s.count)*2])
	clear(s.buffer[s.count*2:])
	s.base = keep
	return nil
}

func (s *sourceAudioResampler) renderLocked(limit float64) error {
	for produced := 0; s.position < limit; produced++ {
		if produced >= 6400 {
			return s.failLocked()
		}
		center := int64(math.Floor(s.position))
		phase := (s.position - float64(center)) * sourceResamplePhases
		index := int(phase)
		fraction := phase - float64(index)
		var left, right float64
		for j := 0; j < sourceResampleTaps; j++ {
			at := center + int64(j-63) - s.base
			if at < 0 || at >= int64(s.count) {
				continue
			}
			coefficient := sourceResampleKernel[index][j] + fraction*(sourceResampleKernel[index+1][j]-sourceResampleKernel[index][j])
			left += float64(s.buffer[at*2]) * coefficient
			right += float64(s.buffer[at*2+1]) * coefficient
		}
		for channel, value := range [2]float64{left, right} {
			value = math.Max(-32768, math.Min(32767, math.Round(value)))
			binary.LittleEndian.PutUint16(s.output[s.outputCount*4+channel*2:], uint16(int16(value)))
		}
		s.outputCount++
		s.position += 1 / s.ratio
		if s.outputCount == sourceAudioMixSamples {
			if err := s.flushLocked(); err != nil {
				return err
			}
		}
	}
	return s.flushLocked()
}

func (s *sourceAudioResampler) flushLocked() error {
	if s.outputCount == 0 {
		return nil
	}
	if !s.cfg.authorized() || s.cursor < 0 || s.cursor+int64(s.outputCount) >= 1<<52 {
		return s.failLocked()
	}
	if err := s.sink.WriteProgramPCM(s.cursor, s.output[:s.outputCount*4]); err != nil {
		return s.failLocked()
	}
	s.cursor += int64(s.outputCount)
	s.hasOutput = true
	s.outputCount = 0
	clear(s.output[:])
	return nil
}

func (s *sourceAudioResampler) clearBufferLocked() {
	clear(s.buffer[:])
	clear(s.output[:])
	s.count, s.outputCount, s.started = 0, 0, false
	// Preserve the input replay fence and already-written program cursor.
}

func (s *sourceAudioResampler) failLocked() error {
	s.closeLocked()
	return errors.New("source resampler policy clock or output denied")
}

func (s *sourceAudioResampler) closeLocked() {
	if s.closed {
		return
	}
	s.closed = true
	s.clearBufferLocked()
	s.cfg = sourceAudioResampleConfig{}
	s.sink.Close()
}

func (s *sourceAudioResampler) Close() { s.mu.Lock(); defer s.mu.Unlock(); s.closeLocked() }
func (s *sourceAudioResampler) Ready() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started && !s.closed
}
