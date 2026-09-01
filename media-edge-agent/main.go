package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

func main() {
	if err := run(); err != nil {
		log.Printf("media edge agent stopped: %v", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	api, closeTransport, err := createWebRTCAPI(cfg)
	if err != nil {
		return err
	}
	defer closeTransport()
	agent := newMediaAgent(cfg, api)
	defer agent.close()
	client := newSignalingClient(cfg, agent)
	agent.setSignaling(client)
	go agent.prune(ctx)
	return client.run(ctx)
}

func createWebRTCAPI(cfg config) (*webrtc.API, func() error, error) {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, nil, fmt.Errorf("register codecs: %w", err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, nil, fmt.Errorf("register interceptors: %w", err)
	}
	settings := webrtc.SettingEngine{}
	var mux ice.UDPMux
	if cfg.udpPort > 0 {
		address := net.JoinHostPort(cfg.listenIP.String(), strconv.Itoa(cfg.udpPort))
		conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: cfg.listenIP, Port: cfg.udpPort})
		if err != nil {
			return nil, nil, fmt.Errorf("open fixed ICE UDP listener %s: %w", address, err)
		}
		mux = ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: conn})
		settings.SetICEUDPMux(mux)
	}
	if cfg.publicIP != nil {
		settings.SetNAT1To1IPs([]string{cfg.publicIP.String()}, webrtc.ICECandidateTypeHost)
	}
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings),
	)
	closeTransport := func() error {
		if mux == nil {
			return nil
		}
		err := mux.Close()
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		return err
	}
	return api, closeTransport, nil
}
