package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/ananta/webrtc-minimize-server/native-broadcast-packager/internal/trustedsframe"
)

// Real codecs and wall-clock scheduling, synthetic already-decrypted inputs and
// sender reports. This does not claim RTP/SFrame or production assignment wiring.
func TestLiveTrustedSourceProgramGeneration(t *testing.T) {
	runLiveTrustedSourceProgram(t, false)
}

func TestLiveTrustedSourceAssignmentProgram(t *testing.T) {
	runLiveTrustedSourceProgram(t, true)
}

func runLiveTrustedSourceProgram(t *testing.T, owned bool) {
	if os.Getenv("RUN_LIVE_TRUSTED_SOURCE_DECODE") != "1" {
		t.Skip("set RUN_LIVE_TRUSTED_SOURCE_DECODE=1 with local FFmpeg")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("explicit generation gate requires FFmpeg")
	}
	red := sourceVideoMixFixtureFrames(t, ffmpeg, "red", "red")[0]
	blue := sourceVideoMixFixtureFrames(t, ffmpeg, "blue", "blue")[0]
	audio := sourceOpusToneFixture(t, ffmpeg, "20", 350, 700)
	c, lease, now := trustedSourceFixture(t)
	cfg := generationTestConfig(t, lease)
	var p *sourceProgramGeneration
	if owned {
		var request sourceProgramAssignment
		c, request, cfg, lease = sourceOwnerFixture(t)
		c.cfg.ffmpegPath = ffmpeg
		if err = c.prepareSourceProgramAssignment(sourceAssignmentBytes(t, request), time.Now(), cfg, nil); err != nil {
			t.Fatal(err)
		}
		p = c.assignment.sourceProgram.generation.Load()
		cfg = p.cfg
		now = time.Now()
	} else {
		cfg.encoder.ffmpegPath = ffmpeg
		p, err = newSourceProgramGeneration(cfg)
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { p.Close(); awaitSource(t, p.finished) })
	leases := []trustedsframe.SourceLease{lease, lease}
	leases[1].SourceLeaseID, leases[1].Consent.ConsentID, leases[1].Consent.SourceID = "sls_bbbbbbbbbbbbbbbb", "cns_bbbbbbbbbbbbbbbb", "src_bbbbbbbbbbbbbbbb"
	leases[1].PublicationID, leases[1].Codec, leases[1].Consent.SourceKind = "audio-source", "audio/opus", "microphone"
	var receivers [2]*trustedsframe.SourceReceiver
	for i := range receivers {
		receivers[i], err = c.prepareTrustedSource(sourceBytes(t, leases[i]), now)
		if err != nil {
			t.Fatal(err)
		}
	}
	var sources [2]*sourceGenerationSource
	for i := range sources {
		if owned {
			var sink trustedSourceSink
			sink, err = c.sourceSinkFor(c.trustedSources[leases[i].SourceLeaseID])
			if err == nil {
				sources[i] = sink.(*sourceGenerationSource)
			}
		} else {
			sources[i], err = p.AddSource(leases[i], receivers[i])
		}
		if err != nil {
			t.Fatal(err)
		}
		rate := uint32(90000)
		if i == 1 {
			rate = 48000
		}
		if err = sources[i].BindSourceClock(uint32(i+1), rate); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = p.SetScene(1, "single", []string{lease.SourceLeaseID}, lease.SourceLeaseID); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for frame := 0; frame < 350; frame++ {
		if owned && frame > 0 && frame%100 == 0 {
			a := p.cfg.scope
			if err = c.renewAssignment(serverMessage{AssignmentID: a.assignmentID, ProgramEpoch: int(a.programEpoch), FencingRevision: int(a.fencingRevision), ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, time.Now()); err != nil {
				t.Fatal("writer renewal", err)
			}
		}
		if frame > 0 && frame%50 == 0 {
			for i := range leases {
				leases[i].Revision++
				leases[i].IssuedAt = time.Now().UnixMilli()
				leases[i].ExpiresAt = leases[i].IssuedAt + 5000
				if err = receivers[i].RenewNow(sourceBytes(t, leases[i])); err != nil {
					t.Fatal("source renewal", err)
				}
			}
		}
		if frame%10 == 0 {
			ntp := uint64(1000)<<32 + (uint64(frame)*20<<32)/1000
			for i, rate := range []uint32{1800, 960} {
				if err = sources[i].SourceSenderReport(sourceSenderReport{ssrc: uint32(i + 1), ntp: ntp, rtp: uint32(frame) * rate}); err != nil {
					t.Fatal("sender report", frame, err)
				}
			}
		}
		if err = sources[1].WriteEncoded("audio/opus", uint32(frame*960), audio[frame]); err != nil {
			t.Fatal("audio input", frame, err)
		}
		if frame%5 == 0 {
			pixels := red
			if frame/25%2 == 1 {
				pixels = blue
			}
			if err = sources[0].WriteEncoded("video/vp8", uint32(frame*1800), pixels); err != nil {
				t.Fatal("video input", frame, err)
			}
		}
		time.Sleep(time.Until(start.Add(time.Duration(frame+1) * 20 * time.Millisecond)))
	}
	if !p.Ready() {
		t.Fatal("generation has no ready HLS output")
	}
	encoder := p.output.(*sourceProgramEncoder)
	for i, rendition := range cfg.encoder.profile.Renditions {
		root := filepath.Join(encoder.owner.output, rendition.ID)
		manifest, err := os.ReadFile(filepath.Join(root, "index.m3u8"))
		if err != nil {
			t.Fatal(err)
		}
		playlist, err := sourceHLSParsePlaylist(manifest, renditionInitFilename(len(cfg.encoder.profile.Renditions), i))
		if err != nil || len(playlist.media) < 3 {
			t.Fatal("generation has no second committed fragment", err)
		}
		init, err := os.ReadFile(filepath.Join(root, playlist.media[0]))
		if err != nil {
			t.Fatal(err)
		}
		segment, err := os.ReadFile(filepath.Join(root, playlist.media[2]))
		if err != nil {
			t.Fatal(err)
		}
		fragment := append(init, segment...)
		video := sourceDecodeEncodedFragment(t, ffmpeg, fragment, rendition.FramesPerSecond)
		frameBytes := rendition.Width * rendition.Height * 4
		reds, blues := 0, 0
		for at := (rendition.Height/2*rendition.Width + rendition.Width/2) * 4; at+4 <= len(video); at += frameBytes {
			if video[at] > 170 && video[at+2] < 50 {
				reds++
			}
			if video[at+2] > 170 && video[at] < 50 {
				blues++
			}
		}
		if reds < 2 || blues < 2 {
			t.Fatalf("generation video froze: rendition=%s red=%d blue=%d frames=%d", rendition.ID, reds, blues, len(video)/frameBytes)
		}
		pcm := sourceDecodeEncodedFragment(t, ffmpeg, fragment, 0)
		var tone audioMixToneProbe
		tone.inspect(0, pcm)
		if level := tone.amplitude(0); level < 0.04 || level > 0.2 {
			t.Fatal("generation lost decoded 700Hz audio", level)
		}
		t.Logf("synthetic composed rendition=%s red=%d blue=%d with decoded 700Hz audio", rendition.ID, reds, blues)
		clear(video)
		clear(pcm)
		clear(fragment)
	}
	receivers[0].Destroy()
	awaitSource(t, p.finished)
	if p.Ready() || encoder.cmd.ProcessState == nil || encoder.cleanupFailed.Load() {
		t.Fatal("generation revoke did not reap output")
	}
	if p.budget.processes != 0 || p.budget.bytes != 0 || len(p.sources) != 0 || len(p.publishers) != 0 {
		t.Fatal("generation retained resources")
	}
	if _, err = os.Stat(filepath.Join(cfg.encoder.outputRoot, cfg.encoder.resourceRef)); !os.IsNotExist(err) {
		t.Fatal("revoked generation remains public")
	}
}
