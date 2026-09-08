package main

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

// PCM16LE is always 48 kHz stereo, borrowed only during the bounded callback.
// Close invalidates queued mixer samples. Callbacks must not reenter decoder.
type sourceAudioOutput interface {
	WritePCM(sampleRate, channels int, timestamp uint32, pcm []byte) error
	Close()
}

type sourceAudioDecodeConfig struct {
	ffmpegPath string
	authorized func() bool // Bounded thread-safe current local policy, no reentry.
	revoked    <-chan struct{}
}

// Only locally generated container headers may be buffered before start.
type sourceOggPipe struct {
	header bytes.Buffer
	output io.Writer
}

func (p *sourceOggPipe) Write(data []byte) (int, error) {
	if p.output != nil {
		return p.output.Write(data)
	}
	if p.header.Len()+len(data) > 512 {
		return 0, errors.New("source opus header budget")
	}
	return p.header.Write(data)
}

type sourceAudioInput struct {
	span  sourceAudioSpan
	frame []byte
}

type sourceAudioDecoder struct {
	*sourceDecodeProcess
	mu              sync.Mutex
	cfg             sourceAudioDecodeConfig
	sink            sourceAudioOutput
	queue           chan sourceAudioInput
	spans           chan sourceAudioSpan
	pipe            *sourceOggPipe
	mux             *oggwriter.OggWriter
	timeline        sourceOpusTimeline
	closed, emitted bool
	pendingSamples  int
	pendingSpans    int
	progressAt      time.Time
	done, finished  chan struct{}
	workers         sync.WaitGroup
}

func sourceAudioDecodeArguments() []string {
	return []string{"-hide_banner", "-nostdin", "-loglevel", "quiet", "-xerror", "-max_alloc", "33554432",
		"-protocol_whitelist", "pipe", "-threads", "1", "-filter_threads", "1",
		"-probesize", "512", "-analyzeduration", "0", "-err_detect", "explode",
		"-c:a", "opus", "-f", "ogg", "-i", "pipe:0", "-map", "0:a:0", "-vn", "-sn", "-dn",
		"-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-threads", "1", "-flush_packets", "1", "-f", "s16le", "pipe:1"}
}

func newSourceAudioDecoder(cfg sourceAudioDecodeConfig, sink sourceAudioOutput) (*sourceAudioDecoder, error) {
	if cfg.ffmpegPath == "" || cfg.authorized == nil || cfg.revoked == nil || sink == nil {
		return nil, errors.New("source audio decoder config")
	}
	select {
	case <-cfg.revoked:
		return nil, errors.New("source audio decoder denied")
	default:
	}
	if !cfg.authorized() {
		return nil, errors.New("source audio decoder denied")
	}
	pipe := &sourceOggPipe{}
	mux, err := oggwriter.NewWith(pipe, 48000, 2)
	if err != nil {
		return nil, errors.New("source opus container unavailable")
	}
	_, header, err := oggreader.NewWith(bytes.NewReader(pipe.header.Bytes()))
	if err != nil || header.Channels != 2 || header.SampleRate != 48000 || header.ChannelMap != 0 || header.PreSkip > 48000 {
		return nil, errors.New("source opus container profile")
	}
	process, err := startSourceDecodeProcess(cfg.ffmpegPath, sourceAudioDecodeArguments())
	if err != nil {
		return nil, err
	}
	d := &sourceAudioDecoder{sourceDecodeProcess: process, cfg: cfg, sink: sink, pipe: pipe, mux: mux,
		queue: make(chan sourceAudioInput, 8), spans: make(chan sourceAudioSpan, 64),
		timeline: sourceOpusTimeline{preSkip: int(header.PreSkip)}, done: make(chan struct{}), finished: make(chan struct{})}
	d.workers.Add(3)
	go func() { defer d.workers.Done(); d.writePackets() }()
	go func() { defer d.workers.Done(); d.readPCM() }()
	go func() { defer d.workers.Done(); d.watch() }()
	go func() {
		d.workers.Wait()
		_ = d.cmd.Wait()
		_ = d.mux.Close()
		clear(d.pipe.header.Bytes())
		d.pipe.header.Reset()
		close(d.finished)
	}()
	return d, nil
}

func (d *sourceAudioDecoder) permitted() bool {
	select {
	case <-d.cfg.revoked:
		return false
	default:
		return d.cfg.authorized()
	}
}

func (d *sourceAudioDecoder) WriteEncoded(codec string, timestamp uint32, frame []byte) error {
	samples, err := sourceOpusSamples(frame)
	d.mu.Lock()
	if d.closed || !d.permitted() || codec != "audio/opus" || err != nil || len(d.queue) == cap(d.queue) {
		d.mu.Unlock()
		d.Close()
		return errors.New("source audio input rejected")
	}
	span, err := d.timeline.accept(timestamp, samples)
	if err != nil {
		d.mu.Unlock()
		d.Close()
		return err
	}
	d.queue <- sourceAudioInput{span: span, frame: append([]byte(nil), frame...)}
	d.mu.Unlock()
	return nil
}

func (d *sourceAudioDecoder) Close() {
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
	d.sink.Close()
	d.mu.Unlock()
	d.sourceDecodeProcess.stop()
}

func (d *sourceAudioDecoder) watch() {
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
			d.mu.Lock()
			emitted := d.emitted
			d.mu.Unlock()
			if !emitted {
				d.Close()
				return
			}
		case <-ticker.C:
			d.mu.Lock()
			stalled := d.pendingSpans > 0 && time.Since(d.progressAt) > 2*time.Second
			d.mu.Unlock()
			if stalled || !d.permitted() {
				d.Close()
				return
			}
		}
	}
}

func (d *sourceAudioDecoder) enqueueSpan(span sourceAudioSpan) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || !d.permitted() || d.pendingSpans >= 64 || d.pendingSamples+span.samples > 48000 {
		return false
	}
	if span.samples == 0 {
		return true // Pre-skip is not a PCM output block.
	}
	if d.pendingSpans == 0 {
		d.progressAt = time.Now()
	}
	d.pendingSpans++
	d.pendingSamples += span.samples
	d.spans <- span
	return true
}

func (d *sourceAudioDecoder) writePackets() {
	defer d.Close()
	if _, err := d.input.Write(d.pipe.header.Bytes()); err != nil {
		return
	}
	d.pipe.output = d.input
	clear(d.pipe.header.Bytes())
	d.pipe.header.Reset()
	for {
		select {
		case <-d.done:
			return
		case packet := <-d.queue:
			if !d.enqueueSpan(packet.span) {
				clear(packet.frame)
				return
			}
			// Pion derives granules from Opus sample counts, not RTP timestamps.
			// Original RTP time, including DTX gaps, stays in the separate span.
			err := d.mux.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2}, Payload: packet.frame})
			clear(packet.frame)
			if err != nil {
				return
			}
		}
	}
}

func (d *sourceAudioDecoder) readPCM() {
	defer d.Close()
	pcm := make([]byte, 5760*4)
	defer clear(pcm)
	for {
		if _, err := io.ReadFull(d.output, pcm[:4]); err != nil {
			return
		}
		var span sourceAudioSpan
		select {
		case span = <-d.spans:
		default:
			return // No unsolicited PCM or output duplicated by the codec profile.
		}
		block := pcm[:span.samples*4]
		if _, err := io.ReadFull(d.output, block[4:]); err != nil {
			return
		}
		d.mu.Lock()
		if d.closed || !d.permitted() {
			d.mu.Unlock()
			return
		}
		err := d.sink.WritePCM(48000, 2, span.timestamp, block)
		clear(block)
		d.pendingSamples -= span.samples
		d.pendingSpans--
		d.emitted, d.progressAt = true, time.Now()
		d.mu.Unlock()
		if err != nil {
			return
		}
	}
}
