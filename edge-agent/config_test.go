package main

import (
	"net"
	"strings"
	"testing"
	"time"
)

func testEnv(values map[string]string) envReader {
	return func(name string) string { return values[name] }
}

func TestLoadConfigIsExplicitAndBounded(t *testing.T) {
	base := map[string]string{
		"EDGE_AGENT_PUBLIC_IP":     "203.0.113.10",
		"EDGE_AGENT_REALM":         "webrtc.example",
		"EDGE_AGENT_SHARED_SECRET": strings.Repeat("x", 32),
	}
	cfg, err := loadConfig(testEnv(base))
	if err != nil {
		t.Fatalf("valid config failed: %v", err)
	}
	if cfg.port != 3478 || cfg.relayMinPort != 49160 || cfg.relayMaxPort != 49259 ||
		cfg.maxAllocations != 64 || !cfg.enableTCP || cfg.allowPrivatePeers ||
		cfg.pcpGateway != nil || cfg.pcpLifetime != 2*time.Hour {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	for _, mutate := range []func(map[string]string){
		func(value map[string]string) { value["EDGE_AGENT_PUBLIC_IP"] = "192.168.1.20" },
		func(value map[string]string) { value["EDGE_AGENT_SHARED_SECRET"] = "short" },
		func(value map[string]string) { value["EDGE_AGENT_MAX_ALLOCATIONS"] = "101" },
		func(value map[string]string) { value["EDGE_AGENT_ENABLE_TCP"] = "maybe" },
		func(value map[string]string) { value["EDGE_AGENT_PCP_GATEWAY"] = "8.8.8.8" },
		func(value map[string]string) { value["EDGE_AGENT_PCP_GATEWAY"] = "fd00::1" },
		func(value map[string]string) {
			value["EDGE_AGENT_RELAY_MIN_PORT"] = "3478"
			value["EDGE_AGENT_RELAY_MAX_PORT"] = "3500"
		},
	} {
		candidate := map[string]string{}
		for key, value := range base {
			candidate[key] = value
		}
		mutate(candidate)
		if _, loadErr := loadConfig(testEnv(candidate)); loadErr == nil {
			t.Fatalf("unsafe config was accepted: %#v", candidate)
		}
	}
	withPCP := map[string]string{}
	for key, value := range base {
		withPCP[key] = value
	}
	withPCP["EDGE_AGENT_PCP_GATEWAY"] = "192.168.178.1"
	withPCP["EDGE_AGENT_PCP_LIFETIME_SECONDS"] = "3600"
	pcpConfig, err := loadConfig(testEnv(withPCP))
	if err != nil || !pcpConfig.pcpGateway.Equal(net.ParseIP("192.168.178.1")) || pcpConfig.pcpLifetime != time.Hour {
		t.Fatalf("valid PCP config failed: %#v, %v", pcpConfig, err)
	}
}
