package main

import (
	"strings"
	"testing"
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
		cfg.maxAllocations != 64 || !cfg.enableTCP || cfg.allowPrivatePeers {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	for _, mutate := range []func(map[string]string){
		func(value map[string]string) { value["EDGE_AGENT_PUBLIC_IP"] = "192.168.1.20" },
		func(value map[string]string) { value["EDGE_AGENT_SHARED_SECRET"] = "short" },
		func(value map[string]string) { value["EDGE_AGENT_MAX_ALLOCATIONS"] = "101" },
		func(value map[string]string) { value["EDGE_AGENT_ENABLE_TCP"] = "maybe" },
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
}
