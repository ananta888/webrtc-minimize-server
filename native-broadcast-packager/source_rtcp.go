package main

import (
	"errors"
	"net"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

const sourceRTCPBytes = 4096

type sourceRTCPBudget struct {
	start, last    time.Time
	packets, bytes int
}

func (b *sourceRTCPBudget) accept(now time.Time, size int) bool {
	if size < 1 || size > sourceRTCPBytes || now.Before(b.last) {
		return false
	}
	b.last = now
	if b.start.IsZero() || now.Sub(b.start) >= time.Second {
		b.start, b.packets, b.bytes = now, 0, 0
	}
	if b.packets >= 64 || b.bytes+size > 64*1024 {
		return false
	}
	b.packets++
	b.bytes += size
	return true
}

func dispatchSourceRTCP(raw []byte, ssrc uint32, clock trustedSourceClockSink) (bool, error) {
	if len(raw) == 0 || len(raw) > sourceRTCPBytes {
		return false, errors.New("source RTCP size")
	}
	packets, err := rtcp.Unmarshal(raw)
	if err != nil || len(packets) == 0 || len(packets) > 16 {
		return false, errors.New("source RTCP format")
	}
	for _, packet := range packets {
		switch value := packet.(type) {
		case *rtcp.SenderReport:
			if clock != nil {
				if value.SSRC != ssrc {
					return false, errors.New("source RTCP scope")
				}
				if err := clock.SourceSenderReport(sourceSenderReport{ssrc: ssrc, ntp: value.NTPTime, rtp: value.RTPTime}); err != nil {
					return false, err
				}
			}
		case *rtcp.Goodbye:
			for _, source := range value.Sources {
				if source == ssrc {
					return true, nil
				}
			}
		}
	}
	return false, nil
}

func (t *trustedSourceTransport) readSourceRTCP(receiver *webrtc.RTPReceiver, ssrc uint32) {
	var buffer [sourceRTCPBytes]byte
	defer clear(buffer[:])
	var budget sourceRTCPBudget
	clock, _ := t.sink.(trustedSourceClockSink)
	for !t.closed.Load() {
		if !t.receiver.AliveNow() {
			t.closeWithFailure(5)
			return
		}
		if clock != nil && clock.SourceClockTick() != nil {
			t.closeWithFailure(8)
			return
		}
		if receiver.SetReadDeadline(time.Now().Add(250*time.Millisecond)) != nil {
			t.closeWithFailure(8)
			return
		}
		n, _, err := receiver.Read(buffer[:])
		if err != nil {
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() {
				continue
			}
			t.closeWithFailure(8)
			return
		}
		if t.closed.Load() {
			return
		}
		if !budget.accept(time.Now(), n) || !t.receiver.AliveNow() {
			t.closeWithFailure(8)
			return
		}
		ended, err := dispatchSourceRTCP(buffer[:n], ssrc, clock)
		clear(buffer[:n])
		if ended || err != nil {
			t.closeWithFailure(8)
			return
		}
	}
}
