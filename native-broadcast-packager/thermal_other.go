//go:build !linux

package main

func readSystemThermalMilliCelsius() []int64 { return nil }
