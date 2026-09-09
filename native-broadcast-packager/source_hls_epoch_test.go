package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestSourceHLSEpochRetainsDiscontinuityWhenFirstSegmentRollsOut(t *testing.T) {
	for _, generation := range []sourceHLSEpoch{0, 1, 2, 127} {
		for _, offset := range []int{0, 1, 8} {
			t.Run(fmt.Sprintf("%d/%d", generation, offset), func(t *testing.T) {
				original := sourceStagePlaylist("init.mp4", int(generation.start())+offset)
				p, err := generation.playlist([]byte(original), "init.mp4")
				if err != nil || len(p.media) != 2 {
					t.Fatalf("projection failed: %v", err)
				}
				got := string(p.data)
				if generation == 0 {
					if got != original {
						t.Fatal("initial timeline changed")
					}
					return
				}
				sequence := uint32(generation)
				if offset == 0 {
					sequence--
				}
				tag := fmt.Sprintf("#EXT-X-DISCONTINUITY-SEQUENCE:%d\n", sequence)
				if strings.Count(got, tag) != 1 || strings.Contains(got, "#EXT-X-DISCONTINUITY\n") != (offset == 0) ||
					strings.Index(got, tag) > strings.Index(got, "#EXT-X-MAP:") {
					t.Fatal("timeline identity lost or reordered")
				}
				if !strings.Contains(got, p.media[1]+"\n") {
					t.Fatal("media identity changed")
				}
			})
		}
	}
}

func TestSourceHLSEpochRejectsReuseOverflowAndProducerDiscontinuity(t *testing.T) {
	for _, e := range []sourceHLSEpoch{0, 1, 127, 128} {
		base := int(e.start())
		for _, sequence := range []int{base - 1, base + int(sourceHLSEpochSpan)} {
			if _, err := e.playlist([]byte(sourceStagePlaylist("init.mp4", sequence)), "init.mp4"); err == nil {
				t.Fatal("foreign partition accepted")
			}
		}
	}
	base := sourceHLSEpoch(1).start()
	valid := sourceStagePlaylist("init.mp4", int(base))
	for _, raw := range []string{
		strings.Replace(valid, fmt.Sprintf("segment_%09d.m4s", base), fmt.Sprintf("segment_%d.m4s", base), 1),
		strings.Replace(valid, fmt.Sprintf("segment_%09d.m4s", base), fmt.Sprintf("segment_%09d.m4s", base+1), 1),
		strings.Replace(valid, "#EXT-X-MAP:", "#EXT-X-DISCONTINUITY\n#EXT-X-MAP:", 1),
		strings.Replace(valid, "#EXT-X-MAP:", "#EXT-X-DISCONTINUITY-SEQUENCE:1\n#EXT-X-MAP:", 1),
	} {
		if _, err := sourceHLSEpoch(1).playlist([]byte(raw), "init.mp4"); err == nil {
			t.Fatal("untrusted timeline accepted")
		}
	}
	if _, err := sourceHLSEpoch(128).playlist([]byte(sourceStagePlaylist("init.mp4", 128_000_000)), "init.mp4"); err == nil {
		t.Fatal("generation budget ignored")
	}
}
