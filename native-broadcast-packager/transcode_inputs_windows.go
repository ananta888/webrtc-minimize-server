package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os/exec"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const localPipeConnectTimeout = 15 * time.Second
const localPipeWriteTimeout = 5 * time.Second

// Only the bounded container headers may be buffered before activation.
// Streaming writes thereafter use kernel backpressure and bounded deadlines.
type windowsMediaPipe struct {
	mu       sync.Mutex
	listener net.Listener
	conn     net.Conn
	prefix   []byte
	active   bool
	closed   bool
	ready    chan struct{}
	done     chan struct{}
}

func newWindowsMediaPipe() (*windowsMediaPipe, string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, "", errors.New("local media pipe identity unavailable")
	}
	var nonce [24]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return nil, "", err
	}
	name := `\\.\pipe\ananta-packager-` + hex.EncodeToString(nonce[:])
	// go-winio creates the first instance exclusively and rejects remote clients.
	listener, err := winio.ListenPipe(name, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;" + user.User.Sid.String() + ")",
		InputBufferSize:    4096, OutputBufferSize: 65536,
	})
	if err != nil {
		return nil, "", errors.New("local media pipe unavailable")
	}
	return &windowsMediaPipe{listener: listener, ready: make(chan struct{}), done: make(chan struct{})}, name, nil
}

func (pipe *windowsMediaPipe) start(pid int, timeout time.Duration, failed func()) {
	pipe.mu.Lock()
	pipe.active = true
	prefix := pipe.prefix
	pipe.prefix = nil
	pipe.mu.Unlock()
	go func() {
		timer := time.AfterFunc(timeout, func() { _ = pipe.listener.Close() })
		conn, err := pipe.listener.Accept()
		timer.Stop()
		_ = pipe.listener.Close()
		if err == nil {
			file, ok := conn.(interface{ Fd() uintptr })
			var clientPID uint32
			if !ok {
				err = errors.New("local media pipe handle unavailable")
			} else {
				err = windows.GetNamedPipeClientProcessId(windows.Handle(file.Fd()), &clientPID)
				if err == nil && (pid <= 0 || clientPID != uint32(pid)) {
					err = errors.New("unexpected media pipe client")
				}
			}
		}
		pipe.mu.Lock()
		if pipe.closed {
			err = io.ErrClosedPipe
		}
		if err == nil {
			pipe.conn = conn
		}
		pipe.mu.Unlock()
		if err == nil {
			err = conn.SetWriteDeadline(time.Now().Add(localPipeWriteTimeout))
			if err == nil {
				_, err = conn.Write(prefix)
			}
		}
		if err != nil {
			if conn != nil {
				_ = conn.Close()
			}
			_ = pipe.Close()
			failed()
			return
		}
		close(pipe.ready)
	}()
}

func (pipe *windowsMediaPipe) Write(value []byte) (int, error) {
	pipe.mu.Lock()
	if pipe.closed {
		pipe.mu.Unlock()
		return 0, io.ErrClosedPipe
	}
	if !pipe.active {
		if len(pipe.prefix)+len(value) > 4096 {
			pipe.mu.Unlock()
			return 0, errors.New("media container header too large")
		}
		pipe.prefix = append(pipe.prefix, value...)
		pipe.mu.Unlock()
		return len(value), nil
	}
	pipe.mu.Unlock()
	select {
	case <-pipe.done:
		return 0, io.ErrClosedPipe
	case <-pipe.ready:
	}
	pipe.mu.Lock()
	conn := pipe.conn
	closed := pipe.closed
	pipe.mu.Unlock()
	if closed || conn == nil {
		return 0, io.ErrClosedPipe
	}
	if err := conn.SetWriteDeadline(time.Now().Add(localPipeWriteTimeout)); err != nil {
		return 0, err
	}
	return conn.Write(value)
}

func (pipe *windowsMediaPipe) Close() error {
	pipe.mu.Lock()
	if pipe.closed {
		pipe.mu.Unlock()
		return nil
	}
	pipe.closed = true
	pipe.prefix = nil
	conn := pipe.conn
	close(pipe.done)
	pipe.mu.Unlock()
	_ = pipe.listener.Close()
	if conn != nil {
		return conn.Close()
	}
	return nil
}

func newTranscodeInputs(hasVideo, hasAudio bool) (*transcodeInputs, error) {
	inputs := &transcodeInputs{configure: func(*exec.Cmd) {}}
	var pipes []*windowsMediaPipe
	inputs.close = func() {
		for _, pipe := range pipes {
			_ = pipe.Close()
		}
	}
	add := func() (io.WriteCloser, string, error) {
		pipe, name, err := newWindowsMediaPipe()
		if err == nil {
			pipes = append(pipes, pipe)
		}
		return pipe, name, err
	}
	var err error
	if hasVideo {
		inputs.video, inputs.videoURL, err = add()
	}
	if err == nil && hasAudio {
		inputs.audio, inputs.audioURL, err = add()
	}
	if err != nil {
		inputs.close()
		return nil, err
	}
	inputs.started = func(cmd *exec.Cmd) {
		for _, pipe := range pipes {
			pipe.start(cmd.Process.Pid, localPipeConnectTimeout, func() { _ = cmd.Process.Kill() })
		}
	}
	return inputs, nil
}
