package main

import (
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func TestPCPMapWireFormatAndResponseValidation(t *testing.T) {
	nonce := [12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	request, err := buildPCPMapRequest(
		net.ParseIP("192.168.178.88"),
		nonce,
		pcpProtocolUDP,
		3478,
		7200,
		3478,
		net.ParseIP("198.51.100.8"),
	)
	if err != nil {
		t.Fatalf("build PCP request: %v", err)
	}
	if len(request) != pcpMapMessageSize || request[0] != pcpVersion || request[1] != pcpMapOpcode ||
		binary.BigEndian.Uint32(request[4:8]) != 7200 || request[36] != pcpProtocolUDP ||
		binary.BigEndian.Uint16(request[40:42]) != 3478 || binary.BigEndian.Uint16(request[42:44]) != 3478 ||
		!net.IP(request[44:60]).Equal(net.ParseIP("198.51.100.8")) {
		t.Fatal("PCP MAP request fields were encoded incorrectly")
	}
	responseBytes := make([]byte, pcpMapMessageSize)
	responseBytes[0] = pcpVersion
	responseBytes[1] = pcpResponseBit | pcpMapOpcode
	binary.BigEndian.PutUint32(responseBytes[4:8], 3600)
	binary.BigEndian.PutUint32(responseBytes[8:12], 42)
	copy(responseBytes[24:36], nonce[:])
	responseBytes[36] = pcpProtocolUDP
	binary.BigEndian.PutUint16(responseBytes[40:42], 3478)
	binary.BigEndian.PutUint16(responseBytes[42:44], 3478)
	copy(responseBytes[44:60], net.ParseIP("198.51.100.8").To16())
	response, err := parsePCPMapResponse(responseBytes)
	if err != nil || response.result != 0 || response.lifetime != 3600 || response.epoch != 42 ||
		response.nonce != nonce || response.protocol != pcpProtocolUDP || response.internalPort != 3478 ||
		response.externalPort != 3478 || !response.externalIP.Equal(net.ParseIP("198.51.100.8")) {
		t.Fatalf("valid PCP MAP response was not parsed: %#v, %v", response, err)
	}
	if _, err := parsePCPMapResponse(responseBytes[:20]); err == nil {
		t.Fatal("truncated PCP response was accepted")
	}
}

func TestPCPRenewalDelayStaysInsideRFCWindow(t *testing.T) {
	for range 100 {
		delay := pcpRenewalDelay(800)
		if delay < 400*time.Second || delay > 500*time.Second {
			t.Fatalf("renewal delay outside 1/2..5/8 window: %s", delay)
		}
	}
}
