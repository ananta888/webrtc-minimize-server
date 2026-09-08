package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const sourceVideoFrameLimit = 4 * 1024 * 1024

// The compositor owns this sink. Both calls must be bounded and nonblocking;
// neither may reenter the decoder. Pixels are borrowed only during WriteRGBA.
// Close must invalidate every retained source frame, not freeze its last image.
type sourceVideoOutput interface {
	WriteRGBA(width, height int, timestamp uint32, pixels []byte) error
	Close()
}

type sourceVideoDecodeConfig struct {
	ffmpegPath    string
	width, height int
	authorized    func() bool // Thread-safe, bounded local policy; must not reenter decoder.
	revoked       <-chan struct{}
}

type sourceVideoInput struct {
	timestamp uint32
	frame     []byte
}

type sourceVideoDecoder struct {
	*sourceDecodeProcess
	mu         sync.Mutex
	cfg        sourceVideoDecodeConfig
	sink       sourceVideoOutput
	queue      chan sourceVideoInput
	timestamps chan uint32
	closed     bool
	started    bool
	last       uint32
	progressAt time.Time
	done       chan struct{}
	finished   chan struct{}
	workers    sync.WaitGroup
}

func sourceVideoDecodeArguments(width, height int) []string {
	// No source-provided paths, decoder names, filter text or network protocols.
	return []string{"-hide_banner", "-nostdin", "-loglevel", "quiet", "-xerror", "-max_alloc", "33554432",
		"-protocol_whitelist", "pipe", "-threads", "1", "-filter_threads", "1",
		"-probesize", "32", "-analyzeduration", "0", "-err_detect", "explode",
		"-c:v", "vp8", "-f", "ivf", "-i", "pipe:0", "-map", "0:v:0", "-an", "-sn", "-dn",
		"-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2", width, height, width, height),
		"-vsync", "0", "-pix_fmt", "rgba", "-threads", "1", "-f", "rawvideo", "pipe:1"}
}

func newSourceVideoDecoder(cfg sourceVideoDecodeConfig, sink sourceVideoOutput) (*sourceVideoDecoder, error) {
	if cfg.ffmpegPath == "" || cfg.width < 2 || cfg.width > 1920 || cfg.height < 2 || cfg.height > 1080 ||
		cfg.width%2 != 0 || cfg.height%2 != 0 || cfg.authorized == nil || cfg.revoked == nil || sink == nil {
		return nil, errors.New("source video decoder config")
	}
	select {
	case <-cfg.revoked:
		return nil, errors.New("source video decoder denied")
	default:
	}
	if !cfg.authorized() {
		return nil, errors.New("source video decoder denied")
	}
	process, err := startSourceDecodeProcess(cfg.ffmpegPath, sourceVideoDecodeArguments(cfg.width, cfg.height))
	if err != nil {
		return nil, err
	}
	d := &sourceVideoDecoder{sourceDecodeProcess: process, cfg: cfg, sink: sink,
		queue: make(chan sourceVideoInput, 2), timestamps: make(chan uint32, 8), done: make(chan struct{}), finished: make(chan struct{})}
	d.workers.Add(3)
	go func() { defer d.workers.Done(); d.writeFrames() }()
	go func() { defer d.workers.Done(); d.readFrames() }()
	go func() { defer d.workers.Done(); d.watch() }()
	go func() {
		// Wait must not close StdoutPipe before the output reader finishes.
		d.workers.Wait()
		_ = d.cmd.Wait()
		close(d.finished)
	}()
	return d, nil
}

// Only displayed, bounded VP8 frames are accepted. Hidden frames need a
// different timestamp-mapping contract and are not silently mis-associated.
func sourceVP8Dimensions(frame []byte) (width, height int, key bool, err error) {
	if len(frame) < 3 || len(frame) > sourceVideoFrameLimit || frame[0]&0x10 == 0 || (frame[0]>>1)&7 > 3 {
		return 0, 0, false, errors.New("source video frame format")
	}
	key = frame[0]&1 == 0
	if key {
		if len(frame) < 10 || frame[3] != 0x9d || frame[4] != 0x01 || frame[5] != 0x2a {
			return 0, 0, false, errors.New("source video keyframe format")
		}
		width = int(binary.LittleEndian.Uint16(frame[6:8]) & 0x3fff)
		height = int(binary.LittleEndian.Uint16(frame[8:10]) & 0x3fff)
		if width < 2 || width > 1920 || height < 2 || height > 1080 {
			return 0, 0, false, errors.New("source video dimensions")
		}
	}
	return width, height, key, nil
}

func (d *sourceVideoDecoder) permitted() bool {
	select {
	case <-d.cfg.revoked:
		return false
	default:
		return d.cfg.authorized()
	}
}

func (d *sourceVideoDecoder) WriteEncoded(codec string, timestamp uint32, frame []byte) error {
	_, _, key, err := sourceVP8Dimensions(frame)
	d.mu.Lock()
	if d.closed || !d.permitted() || codec != "video/vp8" || err != nil ||
		d.started && (timestamp == d.last || timestamp-d.last > 90000*600) {
		d.mu.Unlock()
		d.Close()
		return errors.New("source video input rejected")
	}
	if !d.started && !key {
		d.mu.Unlock()
		return nil // A fresh decoder cannot use delta frames before a keyframe.
	}
	if len(d.queue) == cap(d.queue) {
		d.mu.Unlock()
		d.Close()
		return errors.New("source video input budget")
	}
	d.started, d.last = true, timestamp
	d.queue <- sourceVideoInput{timestamp: timestamp, frame: append([]byte(nil), frame...)}
	d.mu.Unlock()
	return nil
}

func (d *sourceVideoDecoder) Close() {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.closed = true
	close(d.done)
drain:
	for {
		select {
		case packet := <-d.queue:
			clear(packet.frame)
		default:
			break drain
		}
	}
	// Serialized against WriteRGBA: no late output after source invalidation.
	d.sink.Close()
	d.mu.Unlock()
	d.sourceDecodeProcess.stop()
}

func (d *sourceVideoDecoder) watch() {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	startup := time.NewTimer(5 * time.Second)
	defer startup.Stop()
	for {
		select {
		case <-d.done:
			return
		case <-d.cfg.revoked:
			d.Close()
			return
		case <-startup.C:
			// No process may retain an unused decoder indefinitely.
			d.mu.Lock()
			started := d.started
			d.mu.Unlock()
			if !started {
				d.Close()
				return
			}
		case <-ticker.C:
			d.mu.Lock()
			stalled := len(d.timestamps) > 0 && time.Since(d.progressAt) > 2*time.Second
			d.mu.Unlock()
			if stalled || !d.permitted() {
				d.Close()
				return
			}
		}
	}
}

func (d *sourceVideoDecoder) writeFrames() {
	defer d.Close()
	first := true
	var previous uint32
	var pts uint64
	for {
		select {
		case <-d.done:
			return
		case packet := <-d.queue:
			if !d.permitted() {
				clear(packet.frame)
				return
			}
			if first {
				width, height, _, _ := sourceVP8Dimensions(packet.frame)
				var header [32]byte
				copy(header[:], "DKIF")
				binary.LittleEndian.PutUint16(header[6:8], 32)
				copy(header[8:12], "VP80")
				binary.LittleEndian.PutUint16(header[12:14], uint16(width))
				binary.LittleEndian.PutUint16(header[14:16], uint16(height))
				binary.LittleEndian.PutUint32(header[16:20], 90000)
				binary.LittleEndian.PutUint32(header[20:24], 1)
				if _, err := d.input.Write(header[:]); err != nil {
					clear(packet.frame)
					return
				}
				first = false
			} else {
				pts += uint64(packet.timestamp - previous)
			}
			previous = packet.timestamp
			d.mu.Lock()
			if d.closed {
				d.mu.Unlock()
				clear(packet.frame)
				return
			}
			if len(d.timestamps) == 0 {
				d.progressAt = time.Now()
			}
			select {
			case d.timestamps <- packet.timestamp:
				d.mu.Unlock()
			default:
				d.mu.Unlock()
				clear(packet.frame)
				return
			}
			var header [12]byte
			binary.LittleEndian.PutUint32(header[:4], uint32(len(packet.frame)))
			binary.LittleEndian.PutUint64(header[4:], pts)
			_, err := d.input.Write(header[:])
			if err == nil {
				_, err = d.input.Write(packet.frame)
			}
			clear(packet.frame)
			if err != nil {
				return
			}
		}
	}
}

func (d *sourceVideoDecoder) readFrames() {
	defer d.Close()
	pixels := make([]byte, d.cfg.width*d.cfg.height*4)
	defer clear(pixels)
	for {
		if _, err := io.ReadFull(d.output, pixels); err != nil {
			return
		}
		var timestamp uint32
		select {
		case timestamp = <-d.timestamps:
		default:
			return // Unexpected duplicate or unsolicited decoder output.
		}
		d.mu.Lock()
		if d.closed || !d.permitted() {
			d.mu.Unlock()
			return
		}
		err := d.sink.WriteRGBA(d.cfg.width, d.cfg.height, timestamp, pixels)
		d.progressAt = time.Now()
		clear(pixels)
		d.mu.Unlock()
		if err != nil {
			return
		}
	}
}
