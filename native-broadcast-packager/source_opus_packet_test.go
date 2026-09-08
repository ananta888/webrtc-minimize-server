package main

import (
	"bytes"
	"testing"
)

func TestSourceOpusPacketFraming(t *testing.T) {
	for config := 0; config < 32; config++ {
		want := [...]int{480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
			480, 960, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960}[config]
		if actual, err := sourceOpusSamples([]byte{byte(config << 3), 0}); err != nil || actual != want {
			t.Fatalf("TOC configuration %d duration mismatch", config)
		}
	}
	for _, tc := range []struct {
		name    string
		packet  []byte
		samples int
	}{
		{"cbr_two", []byte{0x99, 1, 2}, 1920},
		{"vbr_two", []byte{0x9a, 1, 1, 2, 3}, 1920},
		{"zero_byte_dtx", []byte{0x98}, 960},
		{"cbr_many", []byte{0x9b, 3, 1, 2, 3}, 2880},
		{"vbr_many", []byte{0x9b, 0x83, 0, 1, 1, 2, 3}, 2880},
		{"padding", []byte{0x9b, 0x42, 2, 1, 2, 0, 0}, 1920},
		{"extended_padding", append([]byte{0x9b, 0x41, 255, 0, 1}, make([]byte, 254)...), 960},
		{"long_vbr_frame", append([]byte{0x9a, 252, 0}, make([]byte, 253)...), 1920},
		{"max_frame_size", append([]byte{0x9a, 255, 255}, make([]byte, 1275)...), 1920},
		{"max_duration", []byte{0x9b, 6}, 5760},
		{"max_frame_count", []byte{0x83, 48}, 5760},
		{"truncated_toc", nil, 0},
		{"bad_cbr_length", []byte{0x99, 1}, 0},
		{"bad_vbr_length", []byte{0x9a, 2, 1}, 0},
		{"missing_vbr_length", []byte{0x9a, 252}, 0},
		{"missing_count", []byte{0x9b}, 0},
		{"zero_count", []byte{0x9b, 0}, 0},
		{"too_many_frames", []byte{0x83, 49}, 0},
		{"too_long", []byte{0x9b, 7}, 0},
		{"bad_padding", []byte{0x9b, 0x41, 2, 1}, 0},
		{"truncated_padding", []byte{0x9b, 0x41, 255}, 0},
		{"missing_vbr_sizes", []byte{0x9b, 0x83, 0}, 0},
		{"oversize_frame", append([]byte{0x98}, make([]byte, 1276)...), 0},
		{"oversize_last_vbr_frame", append([]byte{0x9a, 0}, make([]byte, 1276)...), 0},
		{"oversize_packet", bytes.Repeat([]byte{0}, 65536), 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			samples, err := sourceOpusSamples(tc.packet)
			if tc.samples == 0 && err == nil || tc.samples > 0 && (err != nil || samples != tc.samples) {
				t.Fatalf("packet framing result=%d error=%t", samples, err != nil)
			}
		})
	}
}

func TestSourceOpusTimeline(t *testing.T) {
	timeline := sourceOpusTimeline{preSkip: 1000}
	span, err := timeline.accept(0xfffffe00, 960)
	if err != nil || span.samples != 0 || timeline.preSkip != 40 {
		t.Fatal("whole-packet pre-skip")
	}
	span, err = timeline.accept(448, 960)
	if err != nil || span.samples != 920 || span.timestamp != 488 || timeline.preSkip != 0 {
		t.Fatal("partial pre-skip at RTP wrap")
	}
	span, err = timeline.accept(6208, 480)
	if err != nil || span.samples != 480 || span.timestamp != 6208 {
		t.Fatal("DTX gap must keep its original RTP time without synthetic PCM")
	}
	for _, ts := range []uint32{6208, 6209, 6207, 6208 + 48000*600 + 1} {
		copy := timeline
		if _, err := copy.accept(ts, 960); err == nil {
			t.Fatal("invalid RTP sequence accepted")
		}
	}
	for _, size := range []int{-1, 0, 119, 121, 5761} {
		copy := timeline
		if _, err := copy.accept(7168, size); err == nil {
			t.Fatal("invalid sample count accepted")
		}
	}
}

func FuzzSourceOpusPacket(f *testing.F) {
	for _, seed := range [][]byte{{0x98, 1}, {0x9b, 0x42, 2, 1, 2, 0, 0}, {0x9a, 255, 255}} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, packet []byte) {
		samples, err := sourceOpusSamples(packet)
		if err == nil && (samples < 120 || samples > 5760 || samples%120 != 0) {
			t.Fatal("invalid accepted duration")
		}
	})
}
