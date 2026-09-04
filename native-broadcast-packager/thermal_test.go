package main

import "testing"

func TestThermalHealthUsesConservativeBoundedThresholds(t *testing.T) {
	for name, test := range map[string]struct {
		base    string
		samples []int64
		expect  string
	}{
		"no sensor":       {"healthy", nil, "healthy"},
		"normal":          {"healthy", []int64{42_000, 67_000}, "healthy"},
		"degraded":        {"healthy", []int64{81_000}, "degraded"},
		"draining":        {"healthy", []int64{90_000}, "draining"},
		"invalid ignored": {"healthy", []int64{-50_000, 900_000}, "healthy"},
		"base preserved":  {"draining", []int64{20_000}, "draining"},
	} {
		t.Run(name, func(t *testing.T) {
			if actual := thermalHealth(test.base, test.samples); actual != test.expect {
				t.Fatalf("health=%s want=%s", actual, test.expect)
			}
		})
	}
}
