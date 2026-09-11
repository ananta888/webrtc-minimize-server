// Test-only opaque TCP forwarding. No TLS termination, HTTP, DNS, credentials,
// production route configuration, or control-plane authority lives here.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type config struct {
	target   string
	limit    int
	lifetime time.Duration
}

func parseConfig(args []string) (config, error) {
	invalid := errors.New("test_tls_arguments_invalid")
	if len(args) != 4 {
		return config{}, invalid
	}
	ip, err := netip.ParseAddr(args[0])
	if err != nil || !ip.Is4() || !ip.IsPrivate() || ip.As4()[3] != 1 {
		return config{}, invalid
	}
	values := [3]int{}
	for i, raw := range args[1:] {
		n, err := strconv.Atoi(raw)
		if err != nil || strconv.Itoa(n) != raw {
			return config{}, invalid
		}
		values[i] = n
	}
	if values[0] < 1024 || values[0] > 65535 || (values[1] != 16 && values[1] != 32) || values[2] < 180 || values[2] > 7380 {
		return config{}, invalid
	}
	return config{target: net.JoinHostPort(ip.String(), args[1]), limit: values[1], lifetime: time.Duration(values[2]) * time.Second}, nil
}

// The same shared idle deadline covers traffic in either direction, like the
// Node proxy's client socket timeout. Each session owns two bounded buffers.
type activityConn struct {
	net.Conn
	touch func()
}

func (c activityConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func (c activityConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func forward(ctx context.Context, client net.Conn, target string, idle time.Duration) {
	defer client.Close()
	stopClient := context.AfterFunc(ctx, func() { _ = client.Close() })
	defer stopClient()
	backend, err := (&net.Dialer{Timeout: idle}).DialContext(ctx, "tcp4", target)
	if err != nil {
		return
	}
	defer backend.Close()
	stopBackend := context.AfterFunc(ctx, func() { _ = backend.Close() })
	defer stopBackend()
	// Serialize deadline refreshes so two copy goroutines cannot regress the
	// deadline. Either EOF/error closes both directions, as in the Node fixture.
	var activity sync.Mutex
	touch := func() {
		activity.Lock()
		defer activity.Unlock()
		deadline := time.Now().Add(idle)
		_ = client.SetDeadline(deadline)
		_ = backend.SetDeadline(deadline)
	}
	touch()
	a, b := activityConn{client, touch}, activityConn{backend, touch}
	done := make(chan struct{})
	go func() {
		_, _ = io.CopyBuffer(b, a, make([]byte, 32*1024))
		_ = backend.Close()
		_ = client.Close()
		close(done)
	}()
	_, _ = io.CopyBuffer(a, b, make([]byte, 32*1024))
	_ = backend.Close()
	_ = client.Close()
	<-done
}

func serve(ctx context.Context, listener net.Listener, target string, limit int, idle time.Duration, marker func(string)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer listener.Close()
	stop := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stop()
	slots := make(chan struct{}, limit)
	var sessions sync.WaitGroup
	defer sessions.Wait()
	defer cancel()
	drops := 0
	for {
		client, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("test_tls_accept_failed")
		}
		select {
		case slots <- struct{}{}:
			sessions.Add(1)
			go func() {
				defer sessions.Done()
				defer func() { <-slots }()
				forward(ctx, client, target, idle)
			}()
		default:
			_ = client.Close()
			if drops < 8 {
				drops++
				marker("test_tls_connection_capacity")
			}
		}
	}
}

func run(ctx context.Context, args []string, marker func(string)) int {
	marker("test_tls_process_entered")
	cfg, err := parseConfig(args)
	if err != nil {
		marker("test_tls_arguments_invalid")
		return 2
	}
	ctx, cancel := context.WithTimeout(ctx, cfg.lifetime)
	defer cancel()
	marker("test_tls_network_module_loaded")
	listener, err := net.Listen("tcp4", "0.0.0.0:443")
	if err != nil {
		marker("test_tls_listen_failed")
		return 1
	}
	marker("test_tls_listener_ready")
	if serve(ctx, listener, cfg.target, cfg.limit, 120*time.Second, marker) != nil {
		marker("test_tls_accept_failed")
		return 1
	}
	return 0
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	os.Exit(run(ctx, os.Args[1:], func(value string) { fmt.Println(value) }))
}
