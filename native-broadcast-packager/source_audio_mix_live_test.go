package main

import (
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

type countedAudioMixInput struct {
	*sourceAudioMixInput
	samples atomic.Int64
}

func (s *countedAudioMixInput) WritePCM(rate, channels int, timestamp uint32, pcm []byte) error {
	if err := s.sourceAudioMixInput.WritePCM(rate, channels, timestamp, pcm); err != nil {
		return err
	}
	s.samples.Add(int64(len(pcm) / 4))
	return nil
}

type audioMixToneProbe struct {
	real, imaginary [2]float64
	samples         int
}

func (p *audioMixToneProbe) inspect(start int64, pcm []byte) {
	for i := 0; i < len(pcm)/4; i++ {
		value := float64(int16(binary.LittleEndian.Uint16(pcm[i*4:]))) / 32768
		for j, frequency := range []float64{700, 1100} {
			phase := 2 * math.Pi * frequency * float64(start+int64(i)) / 48000
			p.real[j] += value * math.Cos(phase)
			p.imaginary[j] += value * math.Sin(phase)
		}
		p.samples++
	}
}

func (p *audioMixToneProbe) amplitude(index int) float64 {
	return 2 * math.Hypot(p.real[index], p.imaginary[index]) / float64(p.samples)
}

func TestLiveTrustedSourceAudioMixer(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit source audio mixer gate requires FFmpeg")
	}
	m := audioMixFixture(t, 48000, 2)
	var decoders [2]*sourceAudioDecoder
	var sinks [2]*countedAudioMixInput
	var frames [2][][]byte
	var revoked [2]chan struct{}
	var expectedSamples [2]int64
	bases := [2]uint32{0xffffe000, 123456}
	for index, frequency := range []int{700, 1100} {
		frames[index] = sourceOpusToneFixture(t, ffmpeg, "20", 48, frequency)
		base := bases[index]
		// Explicit synthetic sender clocks share a known fixture program epoch.
		// This is not an RTCP/real-network clock synchronization implementation.
		input, err := m.Add(sourceAudioMixInputConfig{left: 32768, right: 32768,
			authorized: func() bool { return true }, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts - base), true }})
		if err != nil {
			t.Fatal(err)
		}
		sinks[index] = &countedAudioMixInput{sourceAudioMixInput: input}
		revoked[index] = make(chan struct{})
		d, err := newSourceAudioDecoder(sourceAudioDecodeConfig{ffmpegPath: ffmpeg,
			authorized: func() bool { return true }, revoked: revoked[index]}, sinks[index])
		if err != nil {
			t.Fatal(err)
		}
		decoders[index] = d
		expectedSamples[index] = int64(48*960 - d.timeline.preSkip)
		t.Cleanup(func() {
			d.Close()
			select {
			case <-d.finished:
			case <-time.After(time.Second):
				t.Error("mixer fixture decoder not reaped")
			}
		})
	}
	for i := 0; i < 48; i++ {
		for index, d := range decoders {
			if err := d.WriteEncoded("audio/opus", bases[index]+uint32(i*960), frames[index][i]); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	deadline := time.Now().Add(time.Second)
	for index := range decoders {
		for sinks[index].samples.Load() != expectedSamples[index] {
			if time.Now().After(deadline) {
				t.Fatal("both real decoders did not fill bounded mixer")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	var both, remaining audioMixToneProbe
	for i := 0; i < 24; i++ {
		if err := m.Render(func(start int64, pcm []byte) error {
			if i >= 8 { // Exclude Opus pre-skip and startup transient.
				both.inspect(start, pcm)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	for index := range decoders {
		if amplitude := both.amplitude(index); amplitude < 0.03 || amplitude > 0.14 {
			t.Fatalf("mixed tone %d amplitude %.4f", index, amplitude)
		}
	}
	close(revoked[0]) // Must wipe the first source's still queued half-second.
	select {
	case <-decoders[0].finished:
	case <-time.After(time.Second):
		t.Fatal("revoked decoder did not stop and invalidate mixer")
	}
	for i := 0; i < 16; i++ {
		if err := m.Render(func(start int64, pcm []byte) error { remaining.inspect(start, pcm); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if remaining.amplitude(0) > 0.003 || remaining.amplitude(1) < 0.03 || remaining.amplitude(1) > 0.14 {
		t.Fatalf("source revoke did not isolate queued tones: %.4f %.4f", remaining.amplitude(0), remaining.amplitude(1))
	}
	close(revoked[1]) // Still eight decoded blocks remain: they must not play.
	select {
	case <-decoders[1].finished:
	case <-time.After(time.Second):
		t.Fatal("final decoder did not stop and invalidate mixer")
	}
	assertAudioMixBlock(t, m, 40*960, audioMixPCM(960, 0, 0))
	if m.pcmBytes != 0 || len(m.sources) != 0 || m.closed {
		t.Fatal("source cleanup stopped parent mixer or retained reservations")
	}
}
