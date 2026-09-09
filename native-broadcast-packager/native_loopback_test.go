package main

import (
	"net"
	"strings"
	"testing"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// Same-process key/RTP tests use actual UDP/DTLS/SCTP/SRTP, but must not depend on
// unrelated host/Docker interfaces. Keep production codecs/interceptors and
// SCTP memory limits; do not reuse this profile for browser or network gates.
func nativeLoopbackAPI(t *testing.T) *webrtc.API {
	t.Helper()
	api, err := createWebRTCAPI()
	if err != nil {
		t.Fatal("loopback WebRTC API unavailable")
	}
	settings := webrtc.SettingEngine{}
	settings.LoggerFactory = logging.NewDefaultLoggerFactory()
	settings.SetSCTPMaxReceiveBufferSize(256 * 1024)
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	webrtc.WithSettingEngine(settings)(api)
	return api
}

func sourceKeyLoopbackCandidates(sdp string) bool {
	count := 0
	for _, line := range strings.Split(sdp, "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 8 || !strings.EqualFold(fields[2], "udp") || fields[6] != "typ" || fields[7] != "host" {
			return false
		}
		ip := net.ParseIP(fields[4])
		if ip == nil || ip.To4() == nil || !ip.IsLoopback() {
			return false
		}
		count++
	}
	return count > 0
}

func TestSourceKeyLoopbackCandidateBoundary(t *testing.T) {
	line := "a=candidate:1 1 udp 1 127.0.0.1 5000 typ host\r\n"
	if !sourceKeyLoopbackCandidates("v=0\r\n" + line) {
		t.Fatal("loopback UDP candidate rejected")
	}
	for _, invalid := range []string{
		"v=0\r\n", "a=candidate:malformed\r\n",
		strings.ReplaceAll(line, "127.0.0.1", "192.0.2.1"),
		strings.ReplaceAll(line, "127.0.0.1", "::1"),
		strings.ReplaceAll(line, "udp", "tcp"),
		strings.ReplaceAll(line, "host", "relay"),
		line + strings.ReplaceAll(line, "127.0.0.1", "192.0.2.1"),
	} {
		if sourceKeyLoopbackCandidates(invalid) {
			t.Fatal("non-loopback or incomplete candidate profile accepted")
		}
	}
}
