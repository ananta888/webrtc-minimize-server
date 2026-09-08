package main

import "errors"

// RFC 6716 section 3: durations use the 48-kHz RTP clock, irrespective of
// encoded bandwidth. This validates framing, not the compressed audio itself.
func sourceOpusSamples(packet []byte) (int, error) {
	fail := func() (int, error) { return 0, errors.New("source opus packet format") }
	if len(packet) == 0 || len(packet) > 65535 {
		return fail()
	}
	config := int(packet[0] >> 3)
	var duration int
	switch {
	case config < 12:
		duration = [...]int{480, 960, 1920, 2880}[config%4]
	case config < 16:
		duration = [...]int{480, 960}[config%2]
	default:
		duration = [...]int{120, 240, 480, 960}[config%4]
	}
	count, offset, end, vbr := 1, 1, len(packet), false
	switch packet[0] & 3 {
	case 1:
		count = 2
	case 2:
		count, vbr = 2, true
	case 3:
		if len(packet) < 2 {
			return fail()
		}
		count, offset, vbr = int(packet[1]&63), 2, packet[1]&128 != 0
		if packet[1]&64 != 0 {
			padding := 0
			for {
				if offset >= end {
					return fail()
				}
				n := int(packet[offset])
				offset++
				if n == 255 {
					padding += 254
				} else {
					padding += n
				}
				if padding > end-offset {
					return fail()
				}
				if n != 255 {
					break
				}
			}
			end -= padding
		}
	}
	if count < 1 || count > 48 || duration*count > 5760 {
		return fail()
	}
	if !vbr {
		if (end-offset)%count != 0 || (end-offset)/count > 1275 {
			return fail()
		}
	} else {
		specified := 0
		for i := 0; i < count-1; i++ {
			if offset >= end {
				return fail()
			}
			length := int(packet[offset])
			offset++
			if length >= 252 {
				if offset >= end {
					return fail()
				}
				length += int(packet[offset]) * 4
				offset++
			}
			specified += length
		}
		remaining := end - offset - specified
		if remaining < 0 || remaining > 1275 {
			return fail()
		}
	}
	return duration * count, nil
}

type sourceAudioSpan struct {
	timestamp uint32
	samples   int
}

type sourceOpusTimeline struct {
	preSkip      int
	started      bool
	last         uint32
	previousSize int
}

func (t *sourceOpusTimeline) accept(timestamp uint32, samples int) (sourceAudioSpan, error) {
	if samples < 120 || samples > 5760 || samples%120 != 0 || t.preSkip < 0 || t.preSkip > 48000 ||
		t.started && (timestamp-t.last < uint32(t.previousSize) || timestamp-t.last > 48000*600) {
		return sourceAudioSpan{}, errors.New("source opus timestamp rejected")
	}
	t.started, t.last, t.previousSize = true, timestamp, samples
	skipped := min(t.preSkip, samples)
	t.preSkip -= skipped
	return sourceAudioSpan{timestamp: timestamp + uint32(skipped), samples: samples - skipped}, nil
}
