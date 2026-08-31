package main

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

const (
	pcpVersion        = 2
	pcpMapOpcode      = 1
	pcpResponseBit    = 0x80
	pcpServerPort     = 5351
	pcpProtocolTCP    = 6
	pcpProtocolUDP    = 17
	pcpMapMessageSize = 60
	pcpRenewTick      = 5 * time.Second
)

type pcpMapKey struct {
	protocol uint8
	port     uint16
}

type pcpMapping struct {
	key          pcpMapKey
	nonce        [12]byte
	externalIP   net.IP
	externalPort uint16
	renewAt      time.Time
	references   int
}

type pcpMapResponse struct {
	result       uint8
	lifetime     uint32
	epoch        uint32
	nonce        [12]byte
	protocol     uint8
	internalPort uint16
	externalPort uint16
	externalIP   net.IP
}

type pcpManager struct {
	mu                sync.Mutex
	conn              *net.UDPConn
	clientIP          net.IP
	publicIP          net.IP
	requestedLifetime uint32
	mappings          map[pcpMapKey]*pcpMapping
	exchangeTimeout   time.Duration
	stop              chan struct{}
	done              chan struct{}
	closed            bool
}

func newPCPManager(gateway, publicIP net.IP, lifetime time.Duration) (*pcpManager, error) {
	remote := &net.UDPAddr{IP: gateway.To4(), Port: pcpServerPort}
	conn, err := net.DialUDP("udp4", nil, remote)
	if err != nil {
		return nil, fmt.Errorf("connect to PCP gateway: %w", err)
	}
	local, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || local.IP.To4() == nil {
		_ = conn.Close()
		return nil, fmt.Errorf("determine PCP client IPv4 address")
	}
	manager := &pcpManager{
		conn:              conn,
		clientIP:          append(net.IP(nil), local.IP...),
		publicIP:          append(net.IP(nil), publicIP...),
		requestedLifetime: uint32(lifetime / time.Second),
		mappings:          make(map[pcpMapKey]*pcpMapping),
		exchangeTimeout:   3 * time.Second,
		stop:              make(chan struct{}),
		done:              make(chan struct{}),
	}
	go manager.renewLoop()
	return manager, nil
}

func (m *pcpManager) acquire(protocol uint8, port uint16) error {
	if (protocol != pcpProtocolUDP && protocol != pcpProtocolTCP) || port == 0 {
		return fmt.Errorf("invalid PCP mapping target")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return net.ErrClosed
	}
	key := pcpMapKey{protocol: protocol, port: port}
	if mapping := m.mappings[key]; mapping != nil {
		mapping.references++
		return nil
	}
	mapping := &pcpMapping{key: key, references: 1}
	if _, err := rand.Read(mapping.nonce[:]); err != nil {
		return fmt.Errorf("generate PCP mapping nonce: %w", err)
	}
	response, err := m.exchangeMapLocked(mapping, m.requestedLifetime, port, m.publicIP, 3)
	if err != nil {
		return err
	}
	if err := m.acceptMappingResponseLocked(mapping, response); err != nil {
		m.sendDeleteLocked(mapping)
		return err
	}
	m.mappings[key] = mapping
	return nil
}

func (m *pcpManager) release(protocol uint8, port uint16) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	key := pcpMapKey{protocol: protocol, port: port}
	mapping := m.mappings[key]
	if mapping == nil {
		return
	}
	if mapping.references > 1 {
		mapping.references--
		return
	}
	delete(m.mappings, key)
	m.sendDeleteLocked(mapping)
}

func (m *pcpManager) Close() error {
	select {
	case <-m.stop:
		return nil
	default:
		close(m.stop)
	}
	<-m.done
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	for key, mapping := range m.mappings {
		m.sendDeleteLocked(mapping)
		delete(m.mappings, key)
	}
	return m.conn.Close()
}

func (m *pcpManager) renewLoop() {
	defer close(m.done)
	ticker := time.NewTicker(pcpRenewTick)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			m.renewDue()
		case <-m.stop:
			return
		}
	}
}

func (m *pcpManager) renewDue() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	now := time.Now()
	var due *pcpMapping
	for _, mapping := range m.mappings {
		if !mapping.renewAt.After(now) && (due == nil || mapping.renewAt.Before(due.renewAt)) {
			due = mapping
		}
	}
	if due == nil {
		return
	}
	response, err := m.exchangeMapLocked(
		due,
		m.requestedLifetime,
		due.externalPort,
		due.externalIP,
		1,
	)
	if err == nil {
		err = m.acceptMappingResponseLocked(due, response)
	}
	if err != nil {
		due.renewAt = now.Add(30 * time.Second)
		log.Print("PCP renewal pending: mappings=1")
	}
}

func (m *pcpManager) acceptMappingResponseLocked(mapping *pcpMapping, response pcpMapResponse) error {
	if response.lifetime == 0 || response.externalPort != mapping.key.port ||
		!response.externalIP.Equal(m.publicIP) {
		return fmt.Errorf("PCP gateway did not grant the required public address and port")
	}
	mapping.externalPort = response.externalPort
	mapping.externalIP = append(net.IP(nil), response.externalIP...)
	mapping.renewAt = time.Now().Add(pcpRenewalDelay(response.lifetime))
	return nil
}

func (m *pcpManager) exchangeMapLocked(
	mapping *pcpMapping,
	lifetime uint32,
	suggestedPort uint16,
	suggestedIP net.IP,
	attempts int,
) (pcpMapResponse, error) {
	request, err := buildPCPMapRequest(
		m.clientIP,
		mapping.nonce,
		mapping.key.protocol,
		mapping.key.port,
		lifetime,
		suggestedPort,
		suggestedIP,
	)
	if err != nil {
		return pcpMapResponse{}, err
	}
	timeout := m.exchangeTimeout
	for attempt := 0; attempt < attempts; attempt++ {
		deadline := time.Now().Add(timeout)
		if err := m.conn.SetDeadline(deadline); err != nil {
			return pcpMapResponse{}, err
		}
		if _, err := m.conn.Write(request); err != nil {
			return pcpMapResponse{}, err
		}
		for {
			buffer := make([]byte, 256)
			size, err := m.conn.Read(buffer)
			if err != nil {
				var networkError net.Error
				if errors.As(err, &networkError) && networkError.Timeout() {
					break
				}
				return pcpMapResponse{}, err
			}
			response, parseErr := parsePCPMapResponse(buffer[:size])
			if parseErr != nil || response.nonce != mapping.nonce ||
				response.protocol != mapping.key.protocol || response.internalPort != mapping.key.port {
				if time.Now().After(deadline) {
					break
				}
				continue
			}
			if response.result != 0 {
				return pcpMapResponse{}, fmt.Errorf("PCP gateway rejected mapping with result code %d", response.result)
			}
			return response, nil
		}
		timeout *= 2
	}
	return pcpMapResponse{}, fmt.Errorf("PCP gateway did not respond")
}

func (m *pcpManager) sendDeleteLocked(mapping *pcpMapping) {
	request, err := buildPCPMapRequest(
		m.clientIP,
		mapping.nonce,
		mapping.key.protocol,
		mapping.key.port,
		0,
		0,
		net.IPv4zero,
	)
	if err != nil {
		return
	}
	_ = m.conn.SetWriteDeadline(time.Now().Add(time.Second))
	_, _ = m.conn.Write(request)
}

func buildPCPMapRequest(
	clientIP net.IP,
	nonce [12]byte,
	protocol uint8,
	internalPort uint16,
	lifetime uint32,
	suggestedPort uint16,
	suggestedIP net.IP,
) ([]byte, error) {
	client16 := clientIP.To16()
	suggested16 := suggestedIP.To16()
	if client16 == nil || suggested16 == nil {
		return nil, fmt.Errorf("PCP addresses must be IPv4 or IPv6")
	}
	request := make([]byte, pcpMapMessageSize)
	request[0] = pcpVersion
	request[1] = pcpMapOpcode
	binary.BigEndian.PutUint32(request[4:8], lifetime)
	copy(request[8:24], client16)
	copy(request[24:36], nonce[:])
	request[36] = protocol
	binary.BigEndian.PutUint16(request[40:42], internalPort)
	binary.BigEndian.PutUint16(request[42:44], suggestedPort)
	copy(request[44:60], suggested16)
	return request, nil
}

func parsePCPMapResponse(message []byte) (pcpMapResponse, error) {
	if len(message) < pcpMapMessageSize || message[0] != pcpVersion ||
		message[1] != pcpResponseBit|pcpMapOpcode {
		return pcpMapResponse{}, fmt.Errorf("invalid PCP MAP response")
	}
	response := pcpMapResponse{
		result:       message[3],
		lifetime:     binary.BigEndian.Uint32(message[4:8]),
		epoch:        binary.BigEndian.Uint32(message[8:12]),
		protocol:     message[36],
		internalPort: binary.BigEndian.Uint16(message[40:42]),
		externalPort: binary.BigEndian.Uint16(message[42:44]),
		externalIP:   append(net.IP(nil), message[44:60]...),
	}
	copy(response.nonce[:], message[24:36])
	return response, nil
}

func pcpRenewalDelay(lifetime uint32) time.Duration {
	var randomByte [1]byte
	_, _ = rand.Read(randomByte[:])
	// RFC 6887 recommends a uniformly jittered renewal between 1/2 and 5/8.
	fraction := 0.5 + (float64(randomByte[0])/255.0)*0.125
	return time.Duration(float64(time.Duration(lifetime)*time.Second) * fraction)
}
