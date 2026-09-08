package main

import "testing"

func TestSourceVideoMixerFutureQueueCannotStarvePresentation(t *testing.T) {
	for _, capacity := range []int{2, 3, 8} {
		m, err := newSourceVideoMixer(sourceVideoMixConfig{width: 64, height: 36, maxSources: 1, queueFrames: capacity,
			maxRGBABytes: 64 * 36 * 4 * (1 + capacity), lookAheadSamples: 48000, authorized: func() bool { return true }})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(m.Close)
		s := videoMixInputFixture(t, m, "camera")
		setVideoMixScene(t, m, "single", []*sourceVideoMixInput{s}, nil)
		red, blue := 0, 0
		for n := 0; n < 120; n++ {
			pixels := solidVideoMix(64, 36, 220, 0, 0)
			if n/15%2 == 1 {
				pixels = solidVideoMix(64, 36, 0, 0, 220)
			}
			// 30 FPS source, 300 ms lookahead: even eight buffers cannot retain
			// everything. Drops are allowed; perpetual slate/frozen video is not.
			if err := s.WriteRGBA(64, 36, uint32(n*1600+14400), pixels); err != nil {
				t.Fatal(err)
			}
			renderVideoMix(t, m, int64(n*1600), func(frame []byte) {
				p := videoMixColor(frame, 64, 0, 0)
				if p[0] == 220 {
					red++
				}
				if p[2] == 220 {
					blue++
				}
			})
			if len(s.pending) > capacity || m.usedBytes != 64*36*4*(1+capacity) {
				t.Fatal("future queue grew")
			}
		}
		if red < 10 || blue < 10 {
			t.Fatalf("future queue starved: capacity=%d red=%d blue=%d", capacity, red, blue)
		}
	}
}
