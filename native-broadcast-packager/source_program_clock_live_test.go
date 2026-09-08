package main

import (
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

type sourceProgramDecodeProbe struct {
	video                          *sourceVideoMixer
	inputs                         [2]*sourceVideoMixInput
	phase, frame                   int
	changes                        [2]int
	seen, red                      [2]bool
	both, remaining                audioMixToneProbe
	lastAudioGuard, lastVideoGuard sourceRenderGuard
	silent, slate                  bool
	closed                         bool
}

func (o *sourceProgramDecodeProbe) WriteProgramAudio(at int64, pcm []byte, g sourceRenderGuard) error {
	if o.closed || !g.Valid() {
		return errors.New("real program audio fence")
	}
	if o.phase == 0 && at >= 8*960 {
		o.both.inspect(at, pcm)
	}
	if o.phase == 1 {
		o.remaining.inspect(at, pcm)
	}
	o.silent = true
	for _, b := range pcm {
		if b != 0 {
			o.silent = false
		}
	}
	o.lastAudioGuard = g
	return nil
}
func (o *sourceProgramDecodeProbe) WriteProgramVideo(_ int64, _ uint64, pixels []byte, g sourceRenderGuard) error {
	if o.closed || !g.Valid() {
		return errors.New("real program video fence")
	}
	o.slate = true
	// Private synchronous callback reads the fixture's current scene while its
	// render lock is held; it never calls a mixer method or performs I/O.
	for _, rect := range o.video.rects {
		color := videoMixColor(pixels, 64, rect.x+rect.width/2, rect.y+rect.height/2)
		s := o.video.scene[rect.source]
		if s == nil {
			if color != [4]byte{9, 19, 31, 255} {
				return errors.New("revoked decoded frame retained")
			}
			continue
		}
		o.slate = false
		index := 0
		if s == o.inputs[1] {
			index = 1
		}
		red := (o.frame+index)%2 == 0
		if color[1] > 30 || color[3] != 255 || red && (color[0] < 200 || color[2] > 30) || !red && (color[2] < 200 || color[0] > 30) {
			return errors.New("real program decoded pixel mismatch")
		}
		if o.seen[index] && o.red[index] != red {
			o.changes[index]++
		}
		o.seen[index], o.red[index] = true, red
	}
	o.lastVideoGuard = g
	return nil
}
func (o *sourceProgramDecodeProbe) Close() { o.closed = true }

func TestLiveTrustedSourceProgramClock(t *testing.T) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit program gate requires FFmpeg")
	}
	audio, video := audioMixFixture(t, 48000, 2), videoMixFixture(t, 2)
	now := time.Unix(1700000000, 0)
	out := &sourceProgramDecodeProbe{video: video}
	p, err := newSourceProgramClock(sourceProgramClockConfig{start: now, now: func() time.Time { return now }, framesPerSecond: 30, maxLagSamples: 4800,
		authorized: func() bool { return true }, revoked: make(chan struct{})}, audio, video, out)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	budget, err := newSourceDecodeBudget(4, 64*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		budget.Close()
		if budget.processes != 0 || budget.bytes != 0 {
			t.Error("program decoder reservation leak")
		}
	})
	var ad [2]*sourceAudioDecoder
	var expectedAudio [2]int64
	var vd [2]*sourceVideoDecoder
	var ai [2]*countedAudioMixInput
	var vi [2]*countedVideoMixInput
	var af, vf [2][][]byte
	var stop [2]chan struct{}
	abases := [2]uint32{0xffffe000, 123456}
	vbases := [2]uint32{0xffff8000, 7654321}
	for i := 0; i < 2; i++ {
		stop[i] = make(chan struct{})
		ab, vb := abases[i], vbases[i]
		x, err := audio.Add(sourceAudioMixInputConfig{left: 32768, right: 32768, authorized: func() bool { return true }, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts - ab), true }})
		if err != nil {
			t.Fatal(err)
		}
		y, err := video.Add(sourceVideoMixInputConfig{width: 64, height: 36, kind: "camera", fit: "contain", maxFrameAgeSamples: 24000, authorized: func() bool { return true }, mapTimestamp: func(ts uint32) (int64, bool) { return int64(ts-vb) * 8 / 15, true }})
		if err != nil {
			t.Fatal(err)
		}
		ai[i], vi[i] = &countedAudioMixInput{sourceAudioMixInput: x}, &countedVideoMixInput{sourceVideoMixInput: y}
		out.inputs[i] = y
		ad[i], err = newSourceAudioDecoder(sourceAudioDecodeConfig{budget: budget, ffmpegPath: ffmpeg, authorized: func() bool { return true }, revoked: stop[i]}, ai[i])
		if err != nil {
			t.Fatal(err)
		}
		expectedAudio[i] = int64(48*960 - ad[i].timeline.preSkip)
		a := ad[i]
		t.Cleanup(func() { a.Close(); awaitSource(t, a.finished) })
		vd[i], err = newSourceVideoDecoder(sourceVideoDecodeConfig{budget: budget, ffmpegPath: ffmpeg, width: 64, height: 36, authorized: func() bool { return true }, revoked: stop[i]}, vi[i])
		if err != nil {
			t.Fatal(err)
		}
		v := vd[i]
		t.Cleanup(func() { v.Close(); awaitSource(t, v.finished) })
		af[i] = sourceOpusToneFixture(t, ffmpeg, "20", 48, 700+400*i)
		colors := [2]string{"red", "blue"}
		vf[i] = sourceVideoMixFixtureFrames(t, ffmpeg, colors[i], colors[1-i])
	}
	// Actual decoders fill a bounded 1-second PCM lookahead. Program time below
	// is explicitly synthetic; this is not a live network synchronization claim.
	for frame := 0; frame < 48; frame++ {
		for i := 0; i < 2; i++ {
			if err := ad[i].WriteEncoded("audio/opus", abases[i]+uint32(frame*960), af[i][frame]); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	for i := 0; i < 2; i++ {
		deadline := time.Now().Add(time.Second)
		for ai[i].samples.Load() != expectedAudio[i] {
			if time.Now().After(deadline) {
				t.Fatal("program PCM decoder deadline")
			}
			time.Sleep(time.Millisecond)
		}
	}
	setVideoMixScene(t, video, "side-by-side", out.inputs[:], nil)
	for frame := 0; frame < 24; frame++ {
		out.frame = frame
		for i := 0; i < 2; i++ {
			if i == 0 && frame >= 15 {
				continue
			}
			if err := vd[i].WriteEncoded("video/vp8", vbases[i]+uint32(frame*3000), vf[i][frame]); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(time.Second)
			for vi[i].count.Load() != int64(frame+1) {
				if time.Now().After(deadline) {
					t.Fatal("program video decoder deadline")
				}
				time.Sleep(time.Millisecond)
			}
		}
		if frame == 20 {
			setVideoMixScene(t, video, "single", out.inputs[1:], nil)
		}
		now = p.cfg.start.Add(time.Duration((int64(frame)*1600*int64(time.Second) + 47999) / 48000))
		if err := p.Step(); err != nil {
			t.Fatal(err)
		}
		if frame == 14 {
			ag, vg := out.lastAudioGuard, out.lastVideoGuard
			close(stop[0])
			awaitSource(t, ad[0].finished)
			awaitSource(t, vd[0].finished)
			if ag.Valid() || vg.Valid() {
				t.Fatal("queued program did not see source revoke")
			}
			out.phase = 1
		}
	}
	if out.changes != [2]int{14, 23} {
		t.Fatal("program video continuity", out.changes)
	}
	for i := 0; i < 2; i++ {
		if amplitude := out.both.amplitude(i); amplitude < 0.03 || amplitude > 0.14 {
			t.Fatal("program mix lost a tone")
		}
	}
	if out.remaining.amplitude(0) > 0.003 || out.remaining.amplitude(1) < 0.03 {
		t.Fatal("program audio revoke isolation")
	}
	close(stop[1])
	awaitSource(t, ad[1].finished)
	awaitSource(t, vd[1].finished)
	out.phase = 2
	now = p.cfg.start.Add(800 * time.Millisecond)
	if err := p.Step(); err != nil {
		t.Fatal(err)
	}
	if !out.silent || !out.slate || out.closed || out.lastAudioGuard.count != 0 || out.lastVideoGuard.count != 0 {
		t.Fatal("empty live program did not continue safely")
	}
}
