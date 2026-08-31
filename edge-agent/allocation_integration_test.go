package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

func TestRealRESTAuthenticatedTURNAllocation(t *testing.T) {
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	cfg := config{
		realm:            "edge.test",
		sharedSecret:     "0123456789abcdef0123456789abcdef",
		maxCredentialTTL: 10 * time.Minute,
		allocationTTL:    time.Minute,
	}
	logger := logging.NewDefaultLoggerFactory()
	logger.DefaultLogLevel = logging.LogLevelDisabled
	quota := newQuotaTracker(4, 2, time.Now)
	server, err := turn.NewServer(turn.ServerConfig{
		Realm:              cfg.realm,
		AuthHandler:        newRESTAuthHandler(cfg, time.Now),
		QuotaHandler:       quota.handler,
		EventHandler:       quota.eventHandler(),
		LoggerFactory:      logger,
		AllocationLifetime: cfg.allocationTTL,
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: udp,
			RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: net.ParseIP("127.0.0.1"),
				Address:      "127.0.0.1",
				MinPort:      52000,
				MaxPort:      52100,
				MaxRetries:   101,
			},
			PermissionHandler: newPermissionHandler(true),
		}},
	})
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	clientConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("client listen: %v", err)
	}
	t.Cleanup(func() { _ = clientConn.Close() })
	username := strconv.FormatInt(time.Now().Add(5*time.Minute).Unix(), 10) + ":0123456789abcdefabcd"
	mac := hmac.New(sha1.New, []byte(cfg.sharedSecret)) // #nosec G401 -- TURN REST interoperability.
	_, _ = mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: udp.LocalAddr().String(),
		TURNServerAddr: udp.LocalAddr().String(),
		Username:       username,
		Password:       password,
		Realm:          cfg.realm,
		Conn:           clientConn,
		RTO:            100 * time.Millisecond,
		LoggerFactory:  logger,
	})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(client.Close)
	if err := client.Listen(); err != nil {
		t.Fatalf("client listen loop: %v", err)
	}
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	t.Cleanup(func() { _ = relay.Close() })
	relayAddress, ok := relay.LocalAddr().(*net.UDPAddr)
	if !ok || !relayAddress.IP.Equal(net.ParseIP("127.0.0.1")) ||
		relayAddress.Port < 52000 || relayAddress.Port > 52100 {
		t.Fatalf("unexpected relay address: %v", relay.LocalAddr())
	}
}
