package main

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

type config struct {
	publicIP           net.IP
	listenIP           net.IP
	port               int
	relayMinPort       uint16
	relayMaxPort       uint16
	realm              string
	sharedSecret       string
	enableTCP          bool
	allowPrivatePeers  bool
	maxCredentialTTL   time.Duration
	allocationTTL      time.Duration
	maxAllocations     int
	maxUserAllocations int
}

type envReader func(string) string

func loadConfig(getenv envReader) (config, error) {
	publicIP := net.ParseIP(strings.TrimSpace(getenv("EDGE_AGENT_PUBLIC_IP")))
	if publicIP == nil || !publicIP.IsGlobalUnicast() || publicIP.IsUnspecified() || publicIP.IsLoopback() || publicIP.IsPrivate() ||
		publicIP.IsLinkLocalUnicast() || publicIP.IsMulticast() {
		return config{}, fmt.Errorf("EDGE_AGENT_PUBLIC_IP must be a public unicast IP address")
	}
	listenDefault := "0.0.0.0"
	if publicIP.To4() == nil {
		listenDefault = "::"
	}
	listenRaw := strings.TrimSpace(getenv("EDGE_AGENT_LISTEN_IP"))
	if listenRaw == "" {
		listenRaw = listenDefault
	}
	listenIP := net.ParseIP(listenRaw)
	if listenIP == nil || (publicIP.To4() == nil) != (listenIP.To4() == nil) {
		return config{}, fmt.Errorf("EDGE_AGENT_LISTEN_IP must match the public IP address family")
	}
	realm := strings.TrimSpace(getenv("EDGE_AGENT_REALM"))
	if realm == "" || len(realm) > 253 || strings.ContainsAny(realm, " \t\r\n") {
		return config{}, fmt.Errorf("EDGE_AGENT_REALM is required and must be a DNS-style realm")
	}
	secret := getenv("EDGE_AGENT_SHARED_SECRET")
	if len(secret) < 32 || len(secret) > 512 || strings.ContainsAny(secret, "\x00\r\n") {
		return config{}, fmt.Errorf("EDGE_AGENT_SHARED_SECRET must contain 32-512 characters")
	}
	port, err := envInt(getenv, "EDGE_AGENT_PORT", 3478, 1024, 65535)
	if err != nil {
		return config{}, err
	}
	minPort, err := envInt(getenv, "EDGE_AGENT_RELAY_MIN_PORT", 49160, 1024, 65535)
	if err != nil {
		return config{}, err
	}
	maxPort, err := envInt(getenv, "EDGE_AGENT_RELAY_MAX_PORT", 49259, minPort, 65535)
	if err != nil {
		return config{}, err
	}
	maxTTLSeconds, err := envInt(getenv, "EDGE_AGENT_MAX_CREDENTIAL_TTL_SECONDS", 900, 60, 3600)
	if err != nil {
		return config{}, err
	}
	allocationSeconds, err := envInt(getenv, "EDGE_AGENT_ALLOCATION_TTL_SECONDS", 600, 60, maxTTLSeconds)
	if err != nil {
		return config{}, err
	}
	maxAllocations, err := envInt(getenv, "EDGE_AGENT_MAX_ALLOCATIONS", 64, 1, maxPort-minPort+1)
	if err != nil {
		return config{}, err
	}
	maxUserAllocations, err := envInt(getenv, "EDGE_AGENT_MAX_USER_ALLOCATIONS", 4, 1, maxAllocations)
	if err != nil {
		return config{}, err
	}
	enableTCP, err := envBool(getenv, "EDGE_AGENT_ENABLE_TCP", true)
	if err != nil {
		return config{}, err
	}
	allowPrivatePeers, err := envBool(getenv, "EDGE_AGENT_ALLOW_PRIVATE_PEERS", false)
	if err != nil {
		return config{}, err
	}
	return config{
		publicIP:           publicIP,
		listenIP:           listenIP,
		port:               port,
		relayMinPort:       uint16(minPort),
		relayMaxPort:       uint16(maxPort),
		realm:              realm,
		sharedSecret:       secret,
		enableTCP:          enableTCP,
		allowPrivatePeers:  allowPrivatePeers,
		maxCredentialTTL:   time.Duration(maxTTLSeconds) * time.Second,
		allocationTTL:      time.Duration(allocationSeconds) * time.Second,
		maxAllocations:     maxAllocations,
		maxUserAllocations: maxUserAllocations,
	}, nil
}

func envInt(getenv envReader, name string, fallback, minimum, maximum int) (int, error) {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", name, minimum, maximum)
	}
	return value, nil
}

func envBool(getenv envReader, name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(strings.ToLower(getenv(name)))
	if raw == "" {
		return fallback, nil
	}
	switch raw {
	case "true", "1":
		return true, nil
	case "false", "0":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true or false", name)
	}
}
