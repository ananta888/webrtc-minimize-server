package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestSourceProgramCapabilityMatchesSharedWire(t *testing.T) {
	raw, err := os.ReadFile("../test/fixtures/native-source-capability.v5.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]any
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}
	c := client{cfg: config{packagerID: "pkr_aaaaaaaaaaaaaaaa", uploadClass: "5-15mbit", energyClass: "ac",
		maximumRenditions: 2, maximumPixelsPerSecond: 1280 * 720 * 30, sourcePrograms: true},
		capability: ffmpegCapability{version: "6.1", videoEncoders: []string{"libx264"}, audioEncoders: []string{"aac"}, health: "healthy"},
		rooms:      []string{"room-alpha"}, healthProbe: func() string { return "healthy" }}
	encoded, err := json.Marshal(c.capabilityMessage())
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	want, got := expected["capability"].(map[string]any), actual["capability"].(map[string]any)
	// These four values genuinely depend on this test host and observation time.
	for _, field := range []string{"hardwareClass", "cpuClass", "observedAt", "expiresAt"} {
		want[field] = got[field]
	}
	if got["expiresAt"].(float64)-got["observedAt"].(float64) != 30000 || !reflect.DeepEqual(expected, actual) {
		t.Fatal("source capability differs from the shared closed wire fixture")
	}
	c.cfg.sourcePrograms = false
	legacy := c.capabilityMessage()["capability"].(map[string]any)
	if legacy["capabilityVersion"] != 1 || len(legacy) != 20 {
		t.Fatal("disabled mode changed the legacy shape")
	}
	if _, exists := legacy["sourcePrograms"]; exists {
		t.Fatal("disabled mode emitted a v2 field")
	}
	if legacy["agentVersion"] != got["agentVersion"] {
		t.Fatal("local opt-in changed the build version")
	}
	c.cfg.sourcePrograms = true
	c.rooms = nil
	empty := c.capabilityMessage()["capability"].(map[string]any)["consentedRoomIds"]
	if !reflect.DeepEqual(empty, []string{}) {
		t.Fatal("new capability without room consent must encode an empty array, not null")
	}
}
