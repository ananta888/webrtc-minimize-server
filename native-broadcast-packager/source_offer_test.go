package main

import (
	"strings"
	"testing"
)

func TestSourceOfferTrackIsOneImmutableTransportLabelNotRoomIdentity(t *testing.T) {
	header := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
	application := "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
	video := "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
	valid := header + video + "a=msid:stream wire-track\r\na=ssrc:1 msid:stream wire-track\r\n" + application
	if id, err := sourceOfferTrack(valid, "video/vp8"); err != nil || id != "wire-track" {
		t.Fatal("single transport label lost", err)
	}
	if id, err := sourceOfferTrack(header+application, "video/vp8"); err != nil || id != "" {
		t.Fatal("key-only negotiation rejected", err)
	}
	for _, raw := range []string{
		header + video + application,
		strings.Replace(valid, "a=ssrc:1 msid:stream wire-track", "a=ssrc:1 msid:stream other-track", 1),
		strings.Replace(valid, "a=ssrc:1 msid:stream wire-track", "a=ssrc:1 msid:other-stream wire-track", 1),
		strings.Replace(valid, "a=msid:stream wire-track", "a=msid:stream wire-track\r\na=msid:stream other-track", 1),
		strings.Replace(valid, "wire-track", strings.Repeat("x", 129), -1),
		strings.Replace(valid, "wire-track", "-", -1),
		strings.Replace(valid, "m=video", "m=audio", 1),
		valid + video + "a=msid:stream wire-track\r\n",
	} {
		if _, err := sourceOfferTrack(raw, "video/vp8"); err == nil {
			t.Fatal("ambiguous or out-of-scope transport accepted")
		}
	}
}
