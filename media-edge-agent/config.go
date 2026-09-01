package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var agentIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

type config struct {
	signalURL       string
	agentID         string
	sharedSecret    string
	identityFile    string
	enrollmentToken string
	caFile          string
	listenIP        net.IP
	publicIP        net.IP
	udpPort         int
	maxRooms        int
	maxPeers        int
	maxTracks       int
	maxPacketBytes  int
	trackQueue      int
	maxBitrate      int64
	capacity        int
	load            int
	battery         string
	network         string
	heartbeat       time.Duration
	reconnectMin    time.Duration
	reconnectMax    time.Duration
}

type envReader func(string) string

func loadConfig(getenv envReader) (config, error) {
	rawURL := strings.TrimSpace(getenv("MEDIA_AGENT_SIGNAL_URL"))
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed == nil || parsed.Scheme != "wss" || parsed.Host == "" || parsed.Path != "/media-agent" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return config{}, fmt.Errorf("MEDIA_AGENT_SIGNAL_URL must be an exact wss:// URL ending in /media-agent")
	}
	agentID := strings.TrimSpace(getenv("MEDIA_AGENT_ID"))
	if !agentIDPattern.MatchString(agentID) {
		return config{}, fmt.Errorf("MEDIA_AGENT_ID must contain lowercase letters, digits or dashes")
	}
	secret := getenv("MEDIA_AGENT_SHARED_SECRET")
	identityFile := strings.TrimSpace(getenv("MEDIA_AGENT_IDENTITY_FILE"))
	if secret != "" && (len(secret) < 32 || len(secret) > 512 || strings.ContainsAny(secret, "\x00\r\n")) {
		return config{}, fmt.Errorf("MEDIA_AGENT_SHARED_SECRET must contain 32-512 characters")
	}
	if identityFile != "" && (len(identityFile) > 4096 || strings.ContainsAny(identityFile, "\x00\r\n")) {
		return config{}, fmt.Errorf("MEDIA_AGENT_IDENTITY_FILE is invalid")
	}
	if (secret == "") == (identityFile == "") {
		return config{}, fmt.Errorf("configure exactly one of MEDIA_AGENT_SHARED_SECRET or MEDIA_AGENT_IDENTITY_FILE")
	}
	enrollmentToken := strings.TrimSpace(getenv("MEDIA_AGENT_ENROLLMENT_TOKEN"))
	if enrollmentToken != "" && !enrollmentTokenPattern.MatchString(enrollmentToken) {
		return config{}, fmt.Errorf("MEDIA_AGENT_ENROLLMENT_TOKEN is invalid")
	}
	listenIP := net.ParseIP(valueOr(getenv("MEDIA_AGENT_LISTEN_IP"), "0.0.0.0"))
	if listenIP == nil || listenIP.To4() == nil {
		return config{}, fmt.Errorf("MEDIA_AGENT_LISTEN_IP must be an IPv4 address")
	}
	var publicIP net.IP
	if raw := strings.TrimSpace(getenv("MEDIA_AGENT_PUBLIC_IP")); raw != "" {
		publicIP = net.ParseIP(raw)
		if publicIP == nil || publicIP.To4() == nil || publicIP.IsUnspecified() || publicIP.IsLoopback() {
			return config{}, fmt.Errorf("MEDIA_AGENT_PUBLIC_IP must be a usable IPv4 address")
		}
	}
	udpPort, err := envInt(getenv, "MEDIA_AGENT_UDP_PORT", 0, 0, 65535)
	if err != nil || (udpPort > 0 && udpPort < 1024) {
		return config{}, fmt.Errorf("MEDIA_AGENT_UDP_PORT must be 0 or an integer between 1024 and 65535")
	}
	maxRooms, err := envInt(getenv, "MEDIA_AGENT_MAX_ROOMS", 8, 1, 32)
	if err != nil {
		return config{}, err
	}
	maxPeers, err := envInt(getenv, "MEDIA_AGENT_MAX_PEERS", 20, 2, 20)
	if err != nil {
		return config{}, err
	}
	maxTracks, err := envInt(getenv, "MEDIA_AGENT_MAX_TRACKS", 80, 1, 80)
	if err != nil {
		return config{}, err
	}
	maxPacketBytes, err := envInt(getenv, "MEDIA_AGENT_MAX_PACKET_BYTES", 2048, 1200, 8192)
	if err != nil {
		return config{}, err
	}
	trackQueue, err := envInt(getenv, "MEDIA_AGENT_TRACK_QUEUE", 128, 16, 512)
	if err != nil {
		return config{}, err
	}
	maxBitrate, err := envInt(getenv, "MEDIA_AGENT_MAX_ROOM_BITRATE_BPS", 50_000_000, 1_000_000, 500_000_000)
	if err != nil {
		return config{}, err
	}
	capacity, err := envInt(getenv, "MEDIA_AGENT_CAPACITY", 70, 0, 100)
	if err != nil {
		return config{}, err
	}
	load, err := envInt(getenv, "MEDIA_AGENT_LOAD", 0, 0, 100)
	if err != nil {
		return config{}, err
	}
	battery := valueOr(getenv("MEDIA_AGENT_BATTERY"), "unknown")
	if !oneOf(battery, "critical", "limited", "mains", "unknown") {
		return config{}, fmt.Errorf("MEDIA_AGENT_BATTERY is invalid")
	}
	network := valueOr(getenv("MEDIA_AGENT_NETWORK"), "unknown")
	if !oneOf(network, "constrained", "normal", "fast", "unknown") {
		return config{}, fmt.Errorf("MEDIA_AGENT_NETWORK is invalid")
	}
	heartbeatSeconds, err := envInt(getenv, "MEDIA_AGENT_HEARTBEAT_SECONDS", 5, 2, 20)
	if err != nil {
		return config{}, err
	}
	return config{
		signalURL:       rawURL,
		agentID:         agentID,
		sharedSecret:    secret,
		identityFile:    identityFile,
		enrollmentToken: enrollmentToken,
		caFile:          strings.TrimSpace(getenv("MEDIA_AGENT_TLS_CA_FILE")),
		listenIP:        listenIP,
		publicIP:        publicIP,
		udpPort:         udpPort,
		maxRooms:        maxRooms,
		maxPeers:        maxPeers,
		maxTracks:       maxTracks,
		maxPacketBytes:  maxPacketBytes,
		trackQueue:      trackQueue,
		maxBitrate:      int64(maxBitrate),
		capacity:        capacity,
		load:            load,
		battery:         battery,
		network:         network,
		heartbeat:       time.Duration(heartbeatSeconds) * time.Second,
		reconnectMin:    time.Second,
		reconnectMax:    30 * time.Second,
	}, nil
}

func (c config) tlsConfig() (*tls.Config, error) {
	result := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.caFile == "" {
		return result, nil
	}
	pem, err := os.ReadFile(c.caFile)
	if err != nil {
		return nil, fmt.Errorf("read MEDIA_AGENT_TLS_CA_FILE: %w", err)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("MEDIA_AGENT_TLS_CA_FILE contains no certificates")
	}
	result.RootCAs = pool
	return result, nil
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

func valueOr(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}

func oneOf(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
