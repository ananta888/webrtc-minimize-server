package main

import (
	"fmt"
	"net"
	"sync"

	"github.com/pion/turn/v5"
)

type portMapper interface {
	acquire(protocol uint8, port uint16) error
	release(protocol uint8, port uint16)
}

type mappedRelayAddressGenerator struct {
	base   turn.RelayAddressGenerator
	mapper portMapper
}

func newMappedRelayAddressGenerator(
	base turn.RelayAddressGenerator,
	mapper portMapper,
) turn.RelayAddressGenerator {
	return &mappedRelayAddressGenerator{base: base, mapper: mapper}
}

func (g *mappedRelayAddressGenerator) Validate() error {
	return g.base.Validate()
}

func (g *mappedRelayAddressGenerator) AllocatePacketConn(
	config turn.AllocateListenerConfig,
) (net.PacketConn, net.Addr, error) {
	conn, address, err := g.base.AllocatePacketConn(config)
	if err != nil {
		return nil, nil, err
	}
	port, err := addressPort(conn.LocalAddr())
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	if err := g.mapper.acquire(pcpProtocolUDP, port); err != nil {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("map UDP relay port: %w", err)
	}
	return &mappedPacketConn{
		PacketConn: conn,
		release:    func() { g.mapper.release(pcpProtocolUDP, port) },
	}, address, nil
}

func (g *mappedRelayAddressGenerator) AllocateListener(
	config turn.AllocateListenerConfig,
) (net.Listener, net.Addr, error) {
	listener, address, err := g.base.AllocateListener(config)
	if err != nil {
		return nil, nil, err
	}
	port, err := addressPort(listener.Addr())
	if err != nil {
		_ = listener.Close()
		return nil, nil, err
	}
	if err := g.mapper.acquire(pcpProtocolTCP, port); err != nil {
		_ = listener.Close()
		return nil, nil, fmt.Errorf("map TCP relay port: %w", err)
	}
	return &mappedListener{
		Listener: listener,
		release:  func() { g.mapper.release(pcpProtocolTCP, port) },
	}, address, nil
}

func (g *mappedRelayAddressGenerator) AllocateConn(config turn.AllocateConnConfig) (net.Conn, error) {
	return g.base.AllocateConn(config)
}

type mappedPacketConn struct {
	net.PacketConn
	once    sync.Once
	release func()
}

func (c *mappedPacketConn) Close() error {
	err := c.PacketConn.Close()
	c.once.Do(c.release)
	return err
}

type mappedListener struct {
	net.Listener
	once    sync.Once
	release func()
}

func (l *mappedListener) Close() error {
	err := l.Listener.Close()
	l.once.Do(l.release)
	return err
}

func addressPort(address net.Addr) (uint16, error) {
	switch value := address.(type) {
	case *net.UDPAddr:
		return uint16(value.Port), nil
	case *net.TCPAddr:
		return uint16(value.Port), nil
	default:
		return 0, fmt.Errorf("unsupported relay address type")
	}
}
