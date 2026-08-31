package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

func main() {
	if err := run(); err != nil {
		log.Printf("edge-agent stopped: %v", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	networkSuffix := "4"
	if cfg.publicIP.To4() == nil {
		networkSuffix = "6"
	}
	listenAddress := net.JoinHostPort(cfg.listenIP.String(), strconv.Itoa(cfg.port))
	udp, err := net.ListenPacket("udp"+networkSuffix, listenAddress)
	if err != nil {
		return fmt.Errorf("open UDP listener: %w", err)
	}
	listeners := []net.Listener{}
	if cfg.enableTCP {
		tcp, listenErr := net.Listen("tcp"+networkSuffix, listenAddress)
		if listenErr != nil {
			_ = udp.Close()
			return fmt.Errorf("open TCP listener: %w", listenErr)
		}
		listeners = append(listeners, tcp)
	}
	permissionHandler := newPermissionHandler(cfg.allowPrivatePeers)
	newGenerator := func() *turn.RelayAddressGeneratorPortRange {
		return &turn.RelayAddressGeneratorPortRange{
			RelayAddress: cfg.publicIP,
			Address:      cfg.listenIP.String(),
			MinPort:      cfg.relayMinPort,
			MaxPort:      cfg.relayMaxPort,
			MaxRetries:   32,
		}
	}
	packetConfigs := []turn.PacketConnConfig{{
		PacketConn:            udp,
		RelayAddressGenerator: newGenerator(),
		PermissionHandler:     permissionHandler,
	}}
	listenerConfigs := make([]turn.ListenerConfig, 0, len(listeners))
	for _, listener := range listeners {
		listenerConfigs = append(listenerConfigs, turn.ListenerConfig{
			Listener:              listener,
			RelayAddressGenerator: newGenerator(),
			PermissionHandler:     permissionHandler,
		})
	}
	quota := newQuotaTracker(cfg.maxAllocations, cfg.maxUserAllocations, time.Now)
	loggerFactory := logging.NewDefaultLoggerFactory()
	loggerFactory.DefaultLogLevel = logging.LogLevelDisabled
	server, err := turn.NewServer(turn.ServerConfig{
		Realm:              cfg.realm,
		AuthHandler:        newRESTAuthHandler(cfg, time.Now),
		QuotaHandler:       quota.handler,
		EventHandler:       quota.eventHandler(),
		PacketConnConfigs:  packetConfigs,
		ListenerConfigs:    listenerConfigs,
		LoggerFactory:      loggerFactory,
		AllocationLifetime: cfg.allocationTTL,
		PermissionTimeout:  min(cfg.allocationTTL, 5*time.Minute),
		ChannelBindTimeout: min(cfg.allocationTTL, 5*time.Minute),
	})
	if err != nil {
		_ = udp.Close()
		for _, listener := range listeners {
			_ = listener.Close()
		}
		return fmt.Errorf("start TURN server: %w", err)
	}
	transport := "UDP"
	if cfg.enableTCP {
		transport = "UDP/TCP"
	}
	log.Printf("edge-agent ready: transport=%s port=%d relay_ports=%d-%d private_peers=%t",
		transport, cfg.port, cfg.relayMinPort, cfg.relayMaxPort, cfg.allowPrivatePeers)
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, shutdownSignals()...)
	<-shutdown
	signal.Stop(shutdown)
	if err := server.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		return fmt.Errorf("close TURN server: %w", err)
	}
	log.Print("edge-agent stopped cleanly")
	return nil
}
