package main

import (
	"strings"
	"testing"
)

func environment(values map[string]string) envReader {
	return func(name string) string { return values[name] }
}

func validEnvironment() map[string]string {
	return map[string]string{
		"MEDIA_AGENT_SIGNAL_URL":    "wss://webrtc.example/media-agent",
		"MEDIA_AGENT_ID":            "laptop-edge",
		"MEDIA_AGENT_SHARED_SECRET": "0123456789abcdef0123456789abcdef",
	}
}

func TestLoadConfigUsesOutboundWSSAndOptionalFixedICEPort(t *testing.T) {
	values := validEnvironment()
	values["MEDIA_AGENT_UDP_PORT"] = "44000"
	values["MEDIA_AGENT_PUBLIC_IP"] = "203.0.113.10"
	cfg, err := loadConfig(environment(values))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.signalURL != values["MEDIA_AGENT_SIGNAL_URL"] || cfg.udpPort != 44000 {
		t.Fatalf("unexpected config: URL=%q UDP=%d", cfg.signalURL, cfg.udpPort)
	}
	if cfg.publicIP.String() != "203.0.113.10" || cfg.maxPeers != 20 || cfg.maxTracks != 80 {
		t.Fatal("bounded defaults or public address were not retained")
	}
}

func TestLoadConfigRejectsInsecureControlAndInvalidSecrets(t *testing.T) {
	for _, mutation := range []func(map[string]string){
		func(values map[string]string) { values["MEDIA_AGENT_SIGNAL_URL"] = "ws://webrtc.example/media-agent" },
		func(values map[string]string) {
			values["MEDIA_AGENT_SIGNAL_URL"] = "wss://webrtc.example/media-agent?token=secret"
		},
		func(values map[string]string) { values["MEDIA_AGENT_SHARED_SECRET"] = "short" },
		func(values map[string]string) { values["MEDIA_AGENT_ID"] = "Laptop" },
		func(values map[string]string) { values["MEDIA_AGENT_UDP_PORT"] = "443" },
	} {
		values := validEnvironment()
		mutation(values)
		if _, err := loadConfig(environment(values)); err == nil {
			t.Fatal("unsafe config was accepted")
		}
	}
}

func TestConfigHasNoMediaKeyOrDecryptListener(t *testing.T) {
	values := validEnvironment()
	cfg, err := loadConfig(environment(values))
	if err != nil {
		t.Fatal(err)
	}
	formatted := strings.ToLower(cfg.signalURL + cfg.agentID + cfg.caFile)
	if strings.Contains(formatted, "sframe-key") || strings.Contains(formatted, "decrypt") {
		t.Fatal("agent config unexpectedly contains a media-key or decrypt endpoint")
	}
}

func TestLoadConfigAcceptsLocalP256IdentityInsteadOfSharedSecret(t *testing.T) {
	values := validEnvironment()
	delete(values, "MEDIA_AGENT_SHARED_SECRET")
	values["MEDIA_AGENT_IDENTITY_FILE"] = "/tmp/ananta-agent-identity.pem"
	values["MEDIA_AGENT_ENROLLMENT_TOKEN"] = strings.Repeat("A", 43)
	cfg, err := loadConfig(environment(values))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.identityFile != values["MEDIA_AGENT_IDENTITY_FILE"] || cfg.enrollmentToken != values["MEDIA_AGENT_ENROLLMENT_TOKEN"] {
		t.Fatal("P-256 identity enrollment config was not retained")
	}
	values["MEDIA_AGENT_SHARED_SECRET"] = "0123456789abcdef0123456789abcdef"
	if _, err = loadConfig(environment(values)); err == nil {
		t.Fatal("ambiguous identity and shared-secret authentication was accepted")
	}
	delete(values, "MEDIA_AGENT_SHARED_SECRET")
	delete(values, "MEDIA_AGENT_IDENTITY_FILE")
	if _, err = loadConfig(environment(values)); err == nil {
		t.Fatal("missing media-agent authentication was accepted")
	}
}
