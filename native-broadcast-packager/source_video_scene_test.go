package main

import (
	"bytes"
	"sync"
	"sync/atomic"
	"testing"
)

func TestSourceVideoSceneGeometry(t *testing.T) {
	for _, size := range [][2]int{{32, 20}, {640, 360}, {1920, 1080}, {1920, 20}, {32, 1080}} {
		for count := 0; count <= 20; count++ {
			kinds := make([]string, count)
			for i := range kinds {
				kinds[i] = "camera"
			}
			if count > 1 {
				kinds[1] = "screen"
			}
			for _, layout := range []string{"single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"} {
				rects, err := sourceVideoSceneRects(layout, kinds, size[0], size[1], count-1)
				if err != nil {
					t.Fatal(err)
				}
				for _, rect := range rects {
					if rect.source < 0 || rect.source >= count || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 ||
						rect.x+rect.width > size[0] || rect.y+rect.height > size[1] {
						t.Fatalf("out-of-bounds %s rectangle %+v at %v", layout, rect, size)
					}
				}
				if layout == "waiting-slate" || layout == "end-slate" || count == 0 {
					if len(rects) != 0 {
						t.Fatal("slate exposes sources")
					}
				} else if layout == "grid" || layout == "side-by-side" || layout == "active-speaker" {
					if len(rects) != count {
						t.Fatal("layout omitted a selected source")
					}
				}
			}
		}
	}
	for _, tc := range []struct {
		layout       string
		kinds        []string
		w, h, active int
	}{
		{"unknown", nil, 64, 36, -1}, {"grid", []string{"audio"}, 64, 36, -1},
		{"grid", nil, 31, 36, -1}, {"grid", nil, 64, 19, -1},
		{"grid", nil, 1921, 36, -1}, {"grid", nil, 64, 1081, -1},
		{"grid", make([]string, 21), 64, 36, -1}, {"single", []string{"camera"}, 64, 36, 1},
	} {
		if _, err := sourceVideoSceneRects(tc.layout, tc.kinds, tc.w, tc.h, tc.active); err == nil {
			t.Fatal("invalid layout accepted")
		}
	}
}

func TestSourceVideoSceneConcurrentCAS(t *testing.T) {
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "camera")
	var workers sync.WaitGroup
	var applied atomic.Int32
	for _, layout := range []string{"single", "grid"} {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if _, err := m.SetScene(1, layout, []*sourceVideoMixInput{s}, nil); err == nil {
				applied.Add(1)
			}
		}()
	}
	workers.Wait()
	if applied.Load() != 1 || m.revision != 2 {
		t.Fatal("concurrent scene revisions both won")
	}
}

func TestSourceVideoScenePixelsAndSelection(t *testing.T) {
	m := videoMixFixture(t, 2)
	camera, screen := videoMixInputFixture(t, m, "camera"), videoMixInputFixture(t, m, "screen")
	for _, entry := range []struct {
		s     *sourceVideoMixInput
		color [3]byte
	}{{camera, [3]byte{255, 0, 0}}, {screen, [3]byte{0, 0, 255}}} {
		if err := entry.s.WriteRGBA(64, 36, 0, solidVideoMix(64, 36, entry.color[0], entry.color[1], entry.color[2])); err != nil {
			t.Fatal(err)
		}
	}
	for i, layout := range []string{"single", "side-by-side", "grid", "screen-presenter", "active-speaker", "waiting-slate", "end-slate"} {
		var active *sourceVideoMixInput
		if layout == "single" || layout == "active-speaker" {
			active = screen
		}
		setVideoMixScene(t, m, layout, []*sourceVideoMixInput{camera, screen}, active)
		renderVideoMix(t, m, int64(i), func(pixels []byte) {
			if layout == "waiting-slate" || layout == "end-slate" {
				if !bytes.Equal(pixels, solidVideoMix(64, 36, 9, 19, 31)) {
					t.Fatal("slate shows source pixels")
				}
				return
			}
			for _, rect := range m.rects {
				// The screen-presenter overlay covers only the corner, not the
				// primary center; all selected tile centers are independently visible.
				want := [4]byte{255, 0, 0, 255}
				if rect.source == 1 {
					want = [4]byte{0, 0, 255, 255}
				}
				if color := videoMixColor(pixels, 64, rect.x+rect.width/2, rect.y+rect.height/2); color != want {
					t.Fatalf("wrong %s source color %v", layout, color)
				}
			}
		})
	}
	setVideoMixScene(t, m, "screen-presenter", []*sourceVideoMixInput{camera, screen}, nil)
	camera.Close()
	renderVideoMix(t, m, 10, func(pixels []byte) {
		if videoMixColor(pixels, 64, 32, 18) != [4]byte{0, 0, 255, 255} {
			t.Fatal("screen lost with presenter")
		}
		r := m.rects[1]
		if videoMixColor(pixels, 64, r.x+r.width/2, r.y+r.height/2) != [4]byte{9, 19, 31, 255} {
			t.Fatal("revoked overlay reveals another source underneath")
		}
	})
}

func TestSourceVideoSceneContainCoverAndBilinear(t *testing.T) {
	pixels := solidVideoMix(4, 2, 255, 0, 0)
	for y := 0; y < 2; y++ {
		for x := 1; x < 3; x++ {
			i := (y*4 + x) * 4
			pixels[i], pixels[i+1], pixels[i+2] = 0, 255, 0
		}
	}
	output := solidVideoMix(8, 8, 9, 19, 31)
	r := sourceVideoRect{width: 8, height: 8}
	blitSourceVideo(output, 8, r, 4, 2, "contain", pixels)
	if videoMixColor(output, 8, 0, 0) != [4]byte{9, 19, 31, 255} || videoMixColor(output, 8, 0, 3) != [4]byte{255, 0, 0, 255} {
		t.Fatal("contain stretched or cropped source")
	}
	blitSourceVideo(output, 8, r, 4, 2, "cover", pixels)
	if !bytes.Equal(output, solidVideoMix(8, 8, 0, 255, 0)) {
		t.Fatal("cover did not center crop")
	}
	// A 2x2 black/white ramp resized to 3x3 has an exact gray center.
	ramp := solidVideoMix(2, 2, 0, 0, 0)
	copy(ramp[4:8], []byte{255, 255, 255, 0})
	copy(ramp[12:16], []byte{255, 255, 255, 0})
	output = make([]byte, 3*3*4)
	blitSourceVideo(output, 3, sourceVideoRect{width: 3, height: 3}, 2, 2, "contain", ramp)
	if videoMixColor(output, 3, 1, 1) != [4]byte{128, 128, 128, 255} {
		t.Fatal("bilinear interpolation or opaque alpha incorrect")
	}
}

func TestSourceVideoSceneRevokedDuringComposition(t *testing.T) {
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "camera")
	setVideoMixScene(t, m, "single", []*sourceVideoMixInput{s}, nil)
	if err := s.WriteRGBA(64, 36, 0, solidVideoMix(64, 36, 255, 0, 0)); err != nil {
		t.Fatal(err)
	}
	calls := 0
	s.cfg.authorized = func() bool { calls++; return calls < 2 }
	renderVideoMix(t, m, 0, func(pixels []byte) {
		if !bytes.Equal(pixels, solidVideoMix(64, 36, 9, 19, 31)) || !s.closed {
			t.Fatal("expired contribution handed off")
		}
	})
}

func TestSourceVideoScenePoolDoesNotGrow(t *testing.T) {
	m := videoMixFixture(t, 1)
	s := videoMixInputFixture(t, m, "camera")
	input := solidVideoMix(64, 36, 255, 0, 0)
	before := m.usedBytes
	allocations := testing.AllocsPerRun(100, func() {
		at := uint32(s.last + 1)
		if err := s.WriteRGBA(64, 36, at, input); err != nil {
			t.Fatal(err)
		}
	})
	if allocations != 0 || len(s.pending) != 3 || cap(s.pending) != 3 || m.usedBytes != before {
		t.Fatalf("frame pool grew: allocations %.1f", allocations)
	}
}

func TestSourceVideoSceneTwentySourcesAtFullHD(t *testing.T) {
	m, err := newSourceVideoMixer(sourceVideoMixConfig{width: 1920, height: 1080, maxSources: 20, queueFrames: 3,
		maxRGBABytes: 12 * 1024 * 1024, lookAheadSamples: 48000, authorized: func() bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	inputs := make([]*sourceVideoMixInput, 20)
	for i := range inputs {
		inputs[i] = videoMixInputFixture(t, m, "camera")
		if err := inputs[i].WriteRGBA(64, 36, 0, solidVideoMix(64, 36, byte(i+100), byte(i+50), byte(i+10))); err != nil {
			t.Fatal(err)
		}
	}
	setVideoMixScene(t, m, "grid", inputs, nil)
	renderVideoMix(t, m, 0, func(pixels []byte) {
		for _, r := range m.rects {
			want := [4]byte{byte(r.source + 100), byte(r.source + 50), byte(r.source + 10), 255}
			if videoMixColor(pixels, 1920, r.x+r.width/2, r.y+r.height/2) != want {
				t.Fatal("full-HD source tile missing")
			}
		}
	})
	at := int64(0)
	if allocations := testing.AllocsPerRun(3, func() {
		at += 1600
		if err := m.Render(at, func(int64, uint64, []byte) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}); allocations != 0 {
		t.Fatalf("render allocates per frame: %.1f", allocations)
	}
}
