package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestFFmpegReportsOnlyHardwareThatCompletesARealEncode(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg is not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	capability, err := probeFFmpeg(ctx, ffmpeg)
	if err != nil {
		t.Skipf("FFmpeg 6 with libx264/AAC is unavailable: %v", err)
	}
	if len(capability.videoEncoders) < 1 || capability.videoEncoders[0] != "libx264" {
		t.Fatalf("software fallback missing from capability: %#v", capability)
	}
	for _, encoder := range capability.videoEncoders[1:] {
		if !probeHardwareVideoEncoder(ctx, ffmpeg, encoder) {
			t.Fatalf("unusable hardware encoder was advertised: %s", encoder)
		}
	}
	for _, encoder := range capability.videoEncoders {
		if encoder == "h264_vaapi" {
			t.Fatal("unimplemented VAAPI pipeline was advertised")
		}
	}
}

func TestCapabilityClassifiesOnlyProbedHardwareFamilies(t *testing.T) {
	for _, scenario := range []struct {
		encoders []string
		gpu      string
	}{
		{[]string{"libx264"}, "none"},
		{[]string{"libx264", "h264_videotoolbox"}, "integrated"},
		{[]string{"libx264", "h264_nvenc"}, "dedicated"},
	} {
		packager := client{
			cfg:        config{packagerID: "pkr_0123456789abcdef", uploadClass: "5-15mbit", energyClass: "ac", maximumRenditions: 1, maximumPixelsPerSecond: 640 * 360 * 15},
			capability: ffmpegCapability{version: "6.1", videoEncoders: scenario.encoders, audioEncoders: []string{"aac"}, health: "healthy"},
		}
		capability := packager.capabilityMessage()["capability"].(map[string]any)
		if capability["gpuClass"] != scenario.gpu {
			t.Fatalf("unexpected GPU class for %v: %v", scenario.encoders, capability["gpuClass"])
		}
	}
}

func TestBuildManifestIsBoundedAndNormalizesUntrustedLinkerValues(t *testing.T) {
	valid := normalizedBuildManifest(strings.Repeat("a", 40), "2026-09-05T08:00:00+02:00")
	if valid.Type != "native-packager-build" || valid.Version != 1 || valid.AgentVersion != agentVersion ||
		valid.Revision != strings.Repeat("a", 40) || valid.BuiltAt != "2026-09-05T06:00:00Z" ||
		valid.GoVersion == "" || valid.OperatingSys == "" || valid.Architecture == "" {
		t.Fatalf("unexpected build manifest: %#v", valid)
	}
	invalid := normalizedBuildManifest("$(unsafe)", time.Now().String())
	if invalid.Revision != "unknown" || invalid.BuiltAt != "unknown" {
		t.Fatalf("untrusted linker values survived normalization: %#v", invalid)
	}
}

func TestReconnectScheduleResetsAfterAnAuthenticatedControlSession(t *testing.T) {
	wait, next := reconnectSchedule(30*time.Second, true)
	if wait != time.Second || next != time.Second {
		t.Fatalf("authenticated reconnect was not reset: wait=%s next=%s", wait, next)
	}
	wait, next = reconnectSchedule(16*time.Second, false)
	if wait != 16*time.Second || next != 30*time.Second {
		t.Fatalf("unauthenticated reconnect was not bounded: wait=%s next=%s", wait, next)
	}
	wait, next = reconnectSchedule(30*time.Second, false)
	if wait != 30*time.Second || next != 30*time.Second {
		t.Fatalf("maximum reconnect delay drifted: wait=%s next=%s", wait, next)
	}
}

func TestConfigRequiresExactSecureOutboundEndpoint(t *testing.T) {
	values := map[string]string{
		"NATIVE_PACKAGER_CONTROL_URL":   "wss://webrtc.example/native-packager",
		"NATIVE_PACKAGER_ID":            "pkr_0123456789abcdef",
		"NATIVE_PACKAGER_IDENTITY_FILE": "/tmp/identity.pem",
	}
	cfg, err := loadConfig(func(name string) string { return values[name] })
	if err != nil || cfg.maximumRenditions != 2 {
		t.Fatalf("valid config rejected: %v", err)
	}
	values["NATIVE_PACKAGER_CONTROL_URL"] = "ws://webrtc.example/native-packager"
	if _, err = loadConfig(func(name string) string { return values[name] }); err == nil {
		t.Fatal("insecure control URL accepted")
	}
	values["NATIVE_PACKAGER_CONTROL_URL"] = "wss://webrtc.example/native-packager?token=secret"
	if _, err = loadConfig(func(name string) string { return values[name] }); err == nil {
		t.Fatal("token-bearing URL accepted")
	}
}

func TestConfigAcceptsOnlyBoundedSTUNURLs(t *testing.T) {
	valid, err := parseStunURLs("stun:stun.example.test:3478,stuns:stun.example.test:5349")
	if err != nil || len(valid) != 2 {
		t.Fatalf("valid STUN URLs rejected: %v", err)
	}
	for _, raw := range []string{
		"turn:turn.example.test:3478",
		"stun:stun.example.test:3478?token=secret",
		"stun:",
		"stun:stun.example.test:3478,stun:stun.example.test:3478",
	} {
		if _, err = parseStunURLs(raw); err == nil {
			t.Fatalf("invalid STUN URL accepted: %s", raw)
		}
	}
}

func TestAuthMessageMatchesP1363Signature(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	message := authMessage("pkr_0123456789abcdef", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1234)
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	proof := make([]byte, 64)
	r.FillBytes(proof[:32])
	s.FillBytes(proof[32:])
	if len(base64.RawURLEncoding.EncodeToString(proof)) != 86 {
		t.Fatal("unexpected P1363 proof length")
	}
}

func TestOperatorManifestIsBoundToOwnerAndPublicKey(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{packagerID: "pkr_0123456789abcdef"}
	manifest, err := createOperatorProvisioningManifest(cfg, identityFromKey(key),
		"https://identity.test/realms/ananta|owner\n", "  Mini-PC   Broadcast-Packager ", "LINUX")
	if err != nil {
		t.Fatal(err)
	}
	if manifest.OwnerPrincipal != "https://identity.test/realms/ananta|owner" || manifest.Label != "Mini-PC Broadcast-Packager" || manifest.Platform != "linux" {
		t.Fatalf("unexpected normalized manifest: %#v", manifest)
	}
	if len(manifest.Proof) != 86 || !strings.HasPrefix(operatorProvisioningMessage(
		manifest.PackagerID, manifest.OwnerPrincipal, manifest.Label, manifest.Platform, manifest.PublicKey,
	), "native-packager-operator-provision-v1\n") {
		t.Fatal("operator proof or canonical message is invalid")
	}
	if _, err = createOperatorProvisioningManifest(cfg, identityFromKey(key), "issuer|owner", "Mini-PC", "android"); err == nil {
		t.Fatal("unsupported operator platform accepted")
	}
}
