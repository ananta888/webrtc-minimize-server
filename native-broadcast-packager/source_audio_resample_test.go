package main

import (
	"encoding/binary"
	"errors"
	"math"
	"sync"
	"testing"
	"time"
)

type resampleTestBlock struct {
	start int64
	pcm   []byte
}
type resampleTestSink struct {
	blocks   []resampleTestBlock
	borrowed []byte
	closed   int
	fail     bool
}

func (s *resampleTestSink) WriteProgramPCM(start int64, pcm []byte) error {
	if s.fail {
		return errors.New("fixture output denied")
	}
	s.borrowed = pcm
	s.blocks = append(s.blocks, resampleTestBlock{start, append([]byte(nil), pcm...)})
	return nil
}
func (s *resampleTestSink) Close() {
	s.closed++
	for _, b := range s.blocks {
		clear(b.pcm)
	}
}

func resampleFixture(t *testing.T, ratio float64) (*sourceAudioResampler, *resampleTestSink) {
	t.Helper()
	out := &resampleTestSink{}
	s, err := newSourceAudioResampler(sourceAudioResampleConfig{authorized: func() bool { return true }, timing: func(ts uint32) (sourceAudioTiming, bool) { return sourceAudioTiming{float64(ts) * ratio, ratio}, true }}, out)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, out
}

func resampleTone(timestamp uint32, samples int, frequency float64) []byte {
	pcm := make([]byte, samples*4)
	for i := 0; i < samples; i++ {
		at := float64(timestamp+uint32(i)) / 48000
		binary.LittleEndian.PutUint16(pcm[i*4:], uint16(int16(math.Round(20000*math.Sin(2*math.Pi*frequency*at)))))
		binary.LittleEndian.PutUint16(pcm[i*4+2:], uint16(int16(math.Round(14000*math.Sin(2*math.Pi*1100*at)))))
	}
	return pcm
}

func TestSourceAudioResamplerConvertsSamplesAndKeepsProgramCursor(t *testing.T) {
	for _, ratio := range []float64{.95, 1, 1.02, 1.05} {
		s, out := resampleFixture(t, ratio)
		for at := uint32(0); at < 48000; at += 960 {
			if err := s.WritePCM(48000, 2, at, resampleTone(at, 960, 700)); err != nil {
				t.Fatal(err)
			}
		}
		var end int64
		var squaredError float64
		count := 0
		for _, block := range out.blocks {
			if block.start != end {
				t.Fatal("overlap or gap in contiguous converted output")
			}
			for i := 0; i < len(block.pcm)/4; i++ {
				at := block.start + int64(i)
				if at < 512 {
					continue
				}
				for channel, profile := range [2][2]float64{{700, 20000}, {1100, 14000}} {
					got := float64(int16(binary.LittleEndian.Uint16(block.pcm[i*4+channel*2:])))
					want := profile[1] * math.Sin(2*math.Pi*profile[0]*float64(at)/48000/ratio)
					squaredError += (got - want) * (got - want)
					count++
				}
			}
			end += int64(len(block.pcm) / 4)
		}
		if math.Abs(float64(end)-(48000-64)*ratio) > 2 || math.Sqrt(squaredError/float64(count)) > 3 {
			t.Fatal("sample conversion duration or waveform differs")
		}
		for _, b := range out.borrowed {
			if b != 0 {
				t.Fatal("borrowed output retained")
			}
		}
		if s.count > 129 {
			t.Fatal("unbounded filter history")
		}
	}
}

func TestSourceAudioResamplerSuppressesAliasedHighFrequency(t *testing.T) {
	s, out := resampleFixture(t, .95)
	for at := uint32(0); at < 9600; at += 960 {
		if s.WritePCM(48000, 2, at, resampleTone(at, 960, 23000)) != nil {
			t.Fatal("tone denied")
		}
	}
	var energy float64
	count := 0
	for _, block := range out.blocks {
		for i := 0; i < len(block.pcm)/4; i++ {
			if block.start+int64(i) < 512 {
				continue
			}
			v := float64(int16(binary.LittleEndian.Uint16(block.pcm[i*4:])))
			energy += v * v
			count++
		}
	}
	if count == 0 || math.Sqrt(energy/float64(count)) > 70 {
		t.Fatal("resampling folded high-frequency input into output")
	}
}

func TestSourceAudioResamplerGapsUnknownTimeAndRevocation(t *testing.T) {
	s, out := resampleFixture(t, 1)
	if s.WritePCM(48000, 2, 0, resampleTone(0, 960, 700)) != nil || s.WritePCM(48000, 2, 9600, resampleTone(9600, 960, 700)) != nil {
		t.Fatal("DTX gap failed")
	}
	previousEnd, foundGap := int64(0), false
	for _, b := range out.blocks {
		if b.start < previousEnd {
			t.Fatal("DTX output overlaps")
		}
		if b.start == 9600 && previousEnd == 960 {
			foundGap = true
		}
		previousEnd = b.start + int64(len(b.pcm)/4)
	}
	if !foundGap {
		t.Fatal("DTX silence was collapsed or synthesized as a large buffer")
	}
	s.cfg.timing = func(uint32) (sourceAudioTiming, bool) { return sourceAudioTiming{}, false }
	if s.WritePCM(48000, 2, 10560, resampleTone(10560, 960, 700)) != nil || s.Ready() || s.count != 0 {
		t.Fatal("unknown clock retained or emitted PCM")
	}
	for _, v := range s.buffer {
		if v != 0 {
			t.Fatal("unknown-clock history retained")
		}
	}
	s.Close()
	s.Close()
	if out.closed != 1 || s.cfg.timing != nil || s.cfg.authorized != nil {
		t.Fatal("resampler terminal cleanup failed")
	}
	if s.WritePCM(48000, 2, 11520, resampleTone(11520, 960, 700)) == nil {
		t.Fatal("closed source revived")
	}
}

func TestSourceAudioResamplerRejectsInvalidInputsAndMidProcessRevoke(t *testing.T) {
	for _, mode := range []string{"format", "oversize", "replay", "nan", "rate", "phase", "policy", "mid-policy", "output"} {
		t.Run(mode, func(t *testing.T) {
			s, out := resampleFixture(t, 1)
			if s.WritePCM(48000, 2, 0, resampleTone(0, 960, 700)) != nil {
				t.Fatal("initial PCM")
			}
			rate, ts, pcm := 48000, uint32(960), resampleTone(960, 960, 700)
			switch mode {
			case "format":
				rate = 44100
			case "oversize":
				pcm = make([]byte, 5761*4)
			case "replay":
				ts = 0
			case "nan":
				s.cfg.timing = func(uint32) (sourceAudioTiming, bool) { return sourceAudioTiming{math.NaN(), 1}, true }
			case "rate":
				s.cfg.timing = func(uint32) (sourceAudioTiming, bool) { return sourceAudioTiming{960, 1.1}, true }
			case "phase":
				s.cfg.timing = func(uint32) (sourceAudioTiming, bool) { return sourceAudioTiming{10000, 1}, true }
			case "policy":
				s.cfg.authorized = func() bool { return false }
			case "mid-policy":
				calls := 0
				s.cfg.authorized = func() bool { calls++; return calls == 1 }
			case "output":
				out.fail = true
			}
			if s.WritePCM(rate, 2, ts, pcm) == nil || !s.closed || out.closed != 1 {
				t.Fatal("invalid resampling input survived")
			}
			for _, v := range s.buffer {
				if v != 0 {
					t.Fatal("closed resampler retained PCM")
				}
			}
		})
	}
}

func TestSourceAudioResamplerUsesExplicitMixerProgramPort(t *testing.T) {
	m := audioMixFixture(t, 48000, 2)
	input, err := m.AddProgram(sourceProgramAudioInputConfig{authorized: func() bool { return true }, left: 32768, right: 32768})
	if err != nil {
		t.Fatal(err)
	}
	s, err := newSourceAudioResampler(sourceAudioResampleConfig{authorized: func() bool { return true }, timing: func(ts uint32) (sourceAudioTiming, bool) { return sourceAudioTiming{float64(ts) * 1.02, 1.02}, true }}, input)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	for at := uint32(0); at < 2880; at += 960 {
		if s.WritePCM(48000, 2, at, audioMixPCM(960, 1000, 2000)) != nil {
			t.Fatal("mixer conversion failed")
		}
	}
	blocks := 0
	if err := m.Render(func(_ int64, pcm []byte) error {
		blocks++
		if int16(binary.LittleEndian.Uint16(pcm[512*4:])) != 1000 {
			t.Fatal("resampled PCM did not reach mixer")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if blocks != 1 || m.closed || m.pcmBytes != 0 {
		t.Fatal("resampler close damaged parent or retained source")
	}
	assertAudioMixBlock(t, m, 960, audioMixPCM(960, 0, 0))
}

type resampleFunctionSink struct {
	write  func(int64, []byte) error
	closes int
}

func (s *resampleFunctionSink) WriteProgramPCM(at int64, pcm []byte) error { return s.write(at, pcm) }
func (s *resampleFunctionSink) Close()                                     { s.closes++ }

func TestSourceAudioResamplerFollowsChangingMeasuredClock(t *testing.T) {
	g, now := clockFixture(t)
	clock, err := g.NewAdaptiveAudioSource()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(clock.Close)
	if clock.BindSourceClock(7, 48000) != nil {
		t.Fatal("clock binding")
	}
	start := *now
	firstRTP := uint32(0xffff0000)
	actual := func(input float64) float64 { return input + .02*input*input/(2*60*48000) }
	var processor *sourceAudioResampler
	var lastEnd int64
	var maximum float64
	blocks := 0
	out := &resampleFunctionSink{write: func(at int64, pcm []byte) error {
		if blocks > 0 && at != lastEnd {
			t.Fatal("clock update rewrote emitted sample time")
		}
		lastEnd = at + int64(len(pcm)/4)
		blocks++
		// The callback runs under the resampler lock; inspect only fixture-owned
		// position, without reentering any production method.
		maximum = math.Max(maximum, math.Abs(14400+actual(processor.position)-float64(lastEnd)))
		return nil
	}}
	processor, err = newSourceAudioResampler(sourceAudioResampleConfig{authorized: func() bool { return true }, timing: clock.AudioTiming}, out)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(processor.Close)
	pcm := audioMixPCM(960, 1000, 2000)
	for input := uint32(0); input < 60*48000; input += 960 {
		program := actual(float64(input))
		*now = start.Add(time.Duration(program / 48000 * float64(time.Second)))
		if input%48000 == 0 {
			ntp := uint64(1000)<<32 + uint64(program/48000*(1<<32))
			if err := clock.SourceSenderReport(sourceSenderReport{7, ntp, firstRTP + input}); err != nil {
				t.Fatal(err)
			}
		}
		if err := processor.WritePCM(48000, 2, firstRTP+input, pcm); err != nil {
			t.Fatal(err)
		}
	}
	if blocks < 2500 || maximum > 4800 || !processor.Ready() {
		t.Fatal("changing measured clock exceeded bounded phase error")
	}
	t.Logf("60 simulated seconds, maximum converted phase error %.3f ms", maximum/48)
}

func TestSourceAudioResamplerConcurrentCloseAndSteadyAllocation(t *testing.T) {
	out := &resampleFunctionSink{write: func(int64, []byte) error { return nil }}
	cfg := sourceAudioResampleConfig{authorized: func() bool { return true }, timing: func(ts uint32) (sourceAudioTiming, bool) { return sourceAudioTiming{float64(ts), 1}, true }}
	s, err := newSourceAudioResampler(cfg, out)
	if err != nil {
		t.Fatal(err)
	}
	pcm := audioMixPCM(960, 1, 2)
	ts := uint32(0)
	allocations := testing.AllocsPerRun(10, func() {
		if s.WritePCM(48000, 2, ts, pcm) != nil {
			t.Fatal("steady conversion")
		}
		ts += 960
	})
	if allocations != 0 {
		t.Fatal("steady resampling allocated per frame")
	}
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		for i := 0; i < 30; i++ {
			_ = s.WritePCM(48000, 2, ts+uint32(i*960), pcm)
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 30; i++ {
			_ = s.Ready()
		}
	}()
	go func() { defer workers.Done(); s.Close(); s.Close() }()
	workers.Wait()
	if !s.closed || out.closes != 1 || s.count != 0 {
		t.Fatal("concurrent close retained resampler state")
	}
}
