//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func readSystemThermalMilliCelsius() []int64 {
	patterns := []string{
		"/sys/class/thermal/thermal_zone*/temp",
		"/sys/class/hwmon/hwmon*/temp*_input",
	}
	values := []int64{}
	seen := map[string]bool{}
	for _, pattern := range patterns {
		files, _ := filepath.Glob(pattern)
		for _, filename := range files {
			if seen[filename] {
				continue
			}
			seen[filename] = true
			raw, err := os.ReadFile(filename)
			if err != nil || len(raw) > 32 {
				continue
			}
			value, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
			if err == nil {
				values = append(values, value)
			}
		}
	}
	return values
}
