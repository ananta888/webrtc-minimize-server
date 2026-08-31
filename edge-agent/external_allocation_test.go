package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

func TestExternalRESTAuthenticatedTURNAllocation(t *testing.T) {
	server := os.Getenv("EDGE_AGENT_TEST_SERVER")
	secret := os.Getenv("EDGE_AGENT_TEST_SECRET")
	realm := os.Getenv("EDGE_AGENT_TEST_REALM")
	if server == "" && secret == "" && realm == "" {
		t.Skip("external Edge TURN endpoint and credential are not configured")
	}
	if server == "" || secret == "" || realm == "" {
		t.Fatal("external Edge TURN test configuration is incomplete")
	}
	minimum := externalTestPort(t, "EDGE_AGENT_TEST_RELAY_MIN_PORT", 49160)
	maximum := externalTestPort(t, "EDGE_AGENT_TEST_RELAY_MAX_PORT", 49259)
	clientConn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal("external Edge TURN client socket failed")
	}
	t.Cleanup(func() { _ = clientConn.Close() })
	username := strconv.FormatInt(time.Now().Add(5*time.Minute).Unix(), 10) + ":0123456789abcdefabcd"
	mac := hmac.New(sha1.New, []byte(secret)) // #nosec G401 -- TURN REST interoperability.
	_, _ = mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	logger := logging.NewDefaultLoggerFactory()
	logger.DefaultLogLevel = logging.LogLevelDisabled
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: server,
		TURNServerAddr: server,
		Username:       username,
		Password:       password,
		Realm:          realm,
		Conn:           clientConn,
		RTO:            250 * time.Millisecond,
		LoggerFactory:  logger,
	})
	if err != nil {
		t.Fatal("external Edge TURN client initialization failed")
	}
	t.Cleanup(client.Close)
	if err := client.Listen(); err != nil {
		t.Fatal("external Edge TURN receive loop failed")
	}
	relay, err := client.Allocate()
	if err != nil {
		t.Fatal("external Edge TURN allocation failed")
	}
	t.Cleanup(func() { _ = relay.Close() })
	relayAddress, ok := relay.LocalAddr().(*net.UDPAddr)
	if !ok || !relayAddress.IP.IsGlobalUnicast() || relayAddress.IP.IsPrivate() ||
		relayAddress.Port < minimum || relayAddress.Port > maximum {
		t.Fatal("external Edge TURN returned an invalid relay address")
	}
}

func externalTestPort(t *testing.T, name string, fallback int) int {
	t.Helper()
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1024 || value > 65535 {
		t.Fatalf("%s is invalid", name)
	}
	return value
}
