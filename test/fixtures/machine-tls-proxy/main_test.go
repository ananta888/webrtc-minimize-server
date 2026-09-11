package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestArguments(t *testing.T) {
	for _, address := range []string{"10.20.0.1", "172.30.0.1", "192.168.5.1"} {
		for _, limit := range []string{"16", "32"} {
			cfg, err := parseConfig([]string{address, "32123", limit, "180"})
			if err != nil || cfg.target != address+":32123" || cfg.lifetime != 180*time.Second {
				t.Fatal("valid arguments rejected")
			}
		}
	}
	for _, args := range [][]string{
		nil, {"10.0.0.1", "32123", "16", "180", "extra"},
		{"public.example", "32123", "16", "180"}, {"127.0.0.1", "32123", "16", "180"},
		{"89.168.123.1", "32123", "16", "180"}, {"::ffff:10.0.0.1", "32123", "16", "180"},
		{"10.0.0.2", "32123", "16", "180"}, {"10.0.0.1", "443", "16", "180"},
		{"10.0.0.1", "65536", "16", "180"}, {"10.0.0.1", "032123", "16", "180"},
		{"10.0.0.1", "+32123", "16", "180"}, {"10.0.0.1", "32123", "17", "180"},
		{"10.0.0.1", "32123", "16", "179"}, {"10.0.0.1", "32123", "16", "7381"},
	} {
		if _, err := parseConfig(args); err == nil || err.Error() != "test_tls_arguments_invalid" {
			t.Fatal("invalid arguments accepted or leaked")
		}
	}
}

type fixture struct {
	address string
	cancel  context.CancelFunc
	done    chan error
	markers chan string
}

func startFixture(t *testing.T, idle time.Duration, lifetime time.Duration) fixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), lifetime)
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		cancel()
		backend.Close()
		t.Fatal(err)
	}
	f := fixture{listener.Addr().String(), cancel, make(chan error, 1), make(chan string, 16)}
	context.AfterFunc(ctx, func() { _ = backend.Close() })
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
				defer stop()
				_, _ = conn.Write([]byte("ready"))
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	go func() {
		f.done <- serve(ctx, listener, backend.Addr().String(), 16, idle, func(s string) { f.markers <- s })
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-f.done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(2 * time.Second):
			t.Error("proxy goroutines did not stop")
		}
	})
	return f
}

func connect(t *testing.T, address string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp4", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	hello := make([]byte, 5)
	if _, err := io.ReadFull(conn, hello); err != nil || string(hello) != "ready" {
		t.Fatal("backend-initiated bytes were not forwarded")
	}
	return conn
}

func TestOpaqueBidirectionalBytes(t *testing.T) {
	f := startFixture(t, time.Second, 10*time.Second)
	conn := connect(t, f.address)
	// Deliberately not HTTP: no parsing or decryption is allowed in the proxy.
	payload := bytes.Repeat([]byte{0, 255, 22, 3, 1, 37, 0, 13}, 16384)
	written := make(chan error, 1)
	go func() { _, err := conn.Write(payload); written <- err }()
	actual := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, actual); err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil || !bytes.Equal(payload, actual) {
		t.Fatal("opaque bytes changed")
	}
}

func TestConnectionCapacityAndBoundedMarkers(t *testing.T) {
	f := startFixture(t, time.Second, 10*time.Second)
	for range 16 {
		connect(t, f.address)
	}
	for range 12 {
		conn, err := net.DialTimeout("tcp4", f.address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var b [1]byte
		n, err := conn.Read(b[:])
		_ = conn.Close()
		if n != 0 || err == nil {
			t.Fatal("excess connection accepted")
		}
		if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Fatal("excess connection not promptly closed")
		}
	}
	// Stop waits for the serving loop, making the marker count deterministic.
	f.cancel()
	if err := <-f.done; err != nil {
		t.Fatal(err)
	}
	f.done <- nil
	if len(f.markers) != 8 {
		t.Fatal("drop marker budget not enforced")
	}
	for len(f.markers) > 0 {
		if <-f.markers != "test_tls_connection_capacity" {
			t.Fatal("raw marker")
		}
	}
}

func TestIdleAndLifetimeCloseExistingStreams(t *testing.T) {
	for _, mode := range []string{"idle", "lifetime", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			idle, lifetime := 5*time.Second, 5*time.Second
			if mode == "idle" {
				idle = 150 * time.Millisecond
			}
			if mode == "lifetime" {
				lifetime = 150 * time.Millisecond
			}
			f := startFixture(t, idle, lifetime)
			conn := connect(t, f.address)
			if mode == "cancel" {
				f.cancel()
			}
			var b [1]byte
			n, err := conn.Read(b[:])
			if n != 0 || err == nil {
				t.Fatal("stream survived stop")
			}
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				t.Fatal("observer deadline is not proxy cleanup")
			}
		})
	}
}

func TestDisconnectedBackendClosesClient(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	target := listener.Addr().String()
	_ = listener.Close()
	client, remote := net.Pipe()
	t.Cleanup(func() { client.Close(); remote.Close() })
	done := make(chan struct{})
	go func() { forward(context.Background(), remote, target, time.Second); close(done) }()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	var b [1]byte
	_, err = client.Read(b[:])
	if err == nil {
		t.Fatal("failed backend left stream open")
	}
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("observer deadline is not backend cleanup")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("forward goroutine did not stop")
	}
}

func TestInvalidRunDoesNotListenOrLeakArguments(t *testing.T) {
	var markers []string
	if status := run(context.Background(), []string{"secret-canary"}, func(s string) { markers = append(markers, s) }); status != 2 {
		t.Fatal("invalid run accepted")
	}
	if strings.Join(markers, ",") != "test_tls_process_entered,test_tls_arguments_invalid" {
		t.Fatal("unexpected output")
	}
}
