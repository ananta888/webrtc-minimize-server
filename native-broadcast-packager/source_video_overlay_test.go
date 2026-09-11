package main

import "testing"

func TestSourceVideoOverlayDefaultOffAndRevoke(t *testing.T) {
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "camera")
	if err := s.WriteRGBA(64, 36, 0, solidVideoMix(64, 36, 80, 10, 10)); err != nil {
		t.Fatal(err)
	}
	setVideoMixScene(t, m, "single", []*sourceVideoMixInput{s}, s)
	var baseline [4]byte
	renderVideoMix(t, m, 0, func(pixels []byte) {
		baseline = videoMixColor(pixels, 64, 3, 3)
		if baseline == [4]byte{0, 0, 0, 255} || baseline == [4]byte{255, 255, 255, 255} {
			t.Fatal("default overlay must not paint a title bar")
		}
	})
	if _, err := m.SetOverlay(m.revision, sourceVideoOverlay{ShowTitle: true, Title: "HI", CaptionStyle: "high-contrast", CaptionPositionPercent: 88}); err != nil {
		t.Fatal(err)
	}
	var titled [4]byte
	renderVideoMix(t, m, 1000, func(pixels []byte) {
		titled = videoMixColor(pixels, 64, 3, 3)
		if titled == baseline {
			t.Fatal("title overlay did not change pixels")
		}
	})
	if _, err := m.SetOverlay(m.revision, emptySourceVideoOverlay()); err != nil {
		t.Fatal(err)
	}
	renderVideoMix(t, m, 2000, func(pixels []byte) {
		if videoMixColor(pixels, 64, 3, 3) == titled {
			t.Fatal("revoked overlay kept title pixels")
		}
	})
}

func TestSourceVideoOverlayRejectsIdentifiersAndStaleCAS(t *testing.T) {
	m := videoMixFixture(t, 1)
	if _, err := m.SetOverlay(m.revision, sourceVideoOverlay{ShowTitle: true, Title: "room-aaaaaaaaaaaaaaaaaa"}); err == nil {
		t.Fatal("room id title accepted")
	}
	if _, err := m.SetOverlay(m.revision, sourceVideoOverlay{ShowCaptions: true, Caption: "prg_aaaaaaaaaaaaaaaa live"}); err == nil {
		t.Fatal("program id caption accepted")
	}
	if _, err := m.SetOverlay(m.revision+1, emptySourceVideoOverlay()); err == nil {
		t.Fatal("stale overlay CAS accepted")
	}
	if _, err := m.SetOverlay(m.revision, sourceVideoOverlay{ShowTitle: true, Title: "HI\nthere"}); err == nil {
		t.Fatal("control characters accepted")
	}
}

func TestSourceVideoOverlayUnauthorizedDoesNotPaint(t *testing.T) {
	allowed := true
	m, err := newSourceVideoMixer(sourceVideoMixConfig{width: 64, height: 36, maxSources: 1, queueFrames: 3,
		maxRGBABytes: 64 * 36 * 4 * 4, lookAheadSamples: 48000, authorized: func() bool { return allowed }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	if _, err := m.SetOverlay(1, sourceVideoOverlay{ShowTitle: true, Title: "HI", CaptionStyle: "high-contrast", CaptionPositionPercent: 88}); err != nil {
		t.Fatal(err)
	}
	allowed = false
	if err := m.Render(0, func(int64, uint64, []byte) error { return nil }); err == nil {
		t.Fatal("unauthorized render succeeded")
	}
}

func TestNativeCaptionCueTextStripsTagsAndIdentifiers(t *testing.T) {
	body := "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c.white>HELLO</c>\n\n00:00:01.000 --> 00:00:02.000\nHI"
	if got := nativeCaptionCueText(body); got != "HI" {
		t.Fatalf("last cue %q", got)
	}
	if nativeCaptionCueText("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nroom-aaaaaaaaaaaaaaaaaa") != "" {
		t.Fatal("identifier cue leaked")
	}
	if nativeCaptionCueText("not vtt") != "" {
		t.Fatal("non-vtt accepted")
	}
}
