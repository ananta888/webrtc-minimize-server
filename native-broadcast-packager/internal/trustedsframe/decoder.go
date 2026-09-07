// Package trustedsframe implements only the codec-prefix-v1 receive boundary
// for an explicitly authorized Trusted-Packager source. It grants no authority
// and must not be imported by a blind relay or the signaling control plane.
package trustedsframe

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"sync"
)

const (
	Envelope      = "codec-prefix-v1"
	MaxFrameBytes = 4 * 1024 * 1024
	maxKeys       = 4
)

var (
	ErrClosed         = errors.New("trusted_sframe_closed")
	ErrKey            = errors.New("trusted_sframe_key")
	ErrFrame          = errors.New("trusted_sframe_frame")
	ErrReplay         = errors.New("trusted_sframe_replay")
	ErrAuthentication = errors.New("trusted_sframe_authentication")
)

type key struct {
	base      [16]byte
	salt      [12]byte
	aead      cipher.AEAD
	expiresAt int64
	replay    replayWindow
}

// Decoder belongs to exactly one already-authorized source/publication. Callers
// must destroy it on consent, publication, membership or writer-lease loss.
// All times are epoch milliseconds supplied by the owning policy adapter.
// Expired/removed KIDs cannot be reused during this decoder's lifetime.
type Decoder struct {
	mu        sync.Mutex
	keys      map[uint64]*key
	seen      map[uint64]struct{}
	expiresAt int64
	lastNow   int64
	closed    bool
	codec     string
}

func New(envelope, codec string, now, expiresAt int64) (*Decoder, error) {
	if envelope != Envelope || (codec != "video/vp8" && codec != "audio/opus") || now <= 0 || expiresAt <= now || expiresAt-now > 600_000 {
		return nil, ErrKey
	}
	return &Decoder{keys: make(map[uint64]*key), seen: make(map[uint64]struct{}), expiresAt: expiresAt, lastNow: now, codec: codec}, nil
}

// Install copies base material and caps key lifetime at 60 seconds and the
// enclosing consent lifetime. A repeated identical install is idempotent only
// with the exact original expiry; it never resets replay or extends authority.
func (d *Decoder) Install(kid uint64, base []byte, now, expiresAt int64) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.current(now); err != nil {
		return err
	}
	if len(base) != 16 || expiresAt <= now || expiresAt > d.expiresAt || expiresAt-now > 60_000 {
		return ErrKey
	}
	if existing := d.keys[kid]; existing != nil {
		if existing.expiresAt != expiresAt || subtle.ConstantTimeCompare(existing.base[:], base) != 1 {
			return ErrKey
		}
		return nil
	}
	if _, used := d.seen[kid]; used {
		return ErrKey
	}
	// The historical budget also bounds rotation churn and tombstone memory.
	if len(d.keys) >= maxKeys || len(d.seen) >= 512 {
		return ErrKey
	}
	var suffix [10]byte
	binary.BigEndian.PutUint64(suffix[:8], kid)
	binary.BigEndian.PutUint16(suffix[8:], 4)
	derived, err := hkdf.Key(sha256.New, base, nil, "SFrame 1.0 Secret key "+string(suffix[:]), 16)
	if err != nil {
		return ErrKey
	}
	defer clear(derived)
	salt, err := hkdf.Key(sha256.New, base, nil, "SFrame 1.0 Secret salt "+string(suffix[:]), 12)
	if err != nil {
		return ErrKey
	}
	defer clear(salt)
	block, err := aes.NewCipher(derived)
	if err != nil {
		return ErrKey
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return ErrKey
	}
	entry := &key{aead: aead, expiresAt: expiresAt}
	copy(entry.base[:], base)
	copy(entry.salt[:], salt)
	d.keys[kid] = entry
	d.seen[kid] = struct{}{}
	return nil
}

// Decrypt accepts a complete depacketized encoded frame, not an RTP packet.
// Codec is explicitly negotiated, never guessed from ciphertext. A VP8 frame's
// key/delta bit selects its packetizer prefix; that prefix is authenticated.
func (d *Decoder) Decrypt(frame []byte, now int64) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.current(now); err != nil {
		return nil, err
	}
	if len(frame) == 0 || len(frame) > MaxFrameBytes {
		return nil, ErrFrame
	}
	prefix, codecID := 0, byte(0)
	switch d.codec {
	case "video/vp8":
		prefix, codecID = 3, 1
		if frame[0]&1 == 0 {
			prefix = 10
		}
	case "audio/opus":
		prefix, codecID = 1, 2
	default:
		return nil, ErrFrame
	}
	if len(frame) < prefix+4+1+16 || !bytes.Equal(frame[prefix:prefix+4], []byte{0x53, 0x46, 1, codecID}) {
		return nil, ErrFrame
	}
	wire := frame[prefix+4:]
	kid, counter, size, err := header(wire)
	if err != nil || len(wire)-size < 16 {
		return nil, ErrFrame
	}
	entry := d.keys[kid]
	if entry == nil {
		return nil, ErrKey
	}
	if !entry.replay.canAccept(counter) {
		return nil, ErrReplay
	}
	nonce := entry.salt
	var encoded [8]byte
	binary.BigEndian.PutUint64(encoded[:], counter)
	for i := range encoded {
		nonce[4+i] ^= encoded[i]
	}
	aad := make([]byte, 0, size+4+prefix)
	aad = append(aad, wire[:size]...)
	aad = append(aad, frame[prefix:prefix+4]...)
	aad = append(aad, frame[:prefix]...)
	plaintext, err := entry.aead.Open(nil, nonce[:], wire[size:], aad)
	if err != nil {
		return nil, ErrAuthentication
	}
	// Replay state advances only after authentication, under the same lock as
	// removal/destruction. Corrupt high counters cannot poison valid frames.
	entry.replay.accept(counter)
	output := make([]byte, prefix+len(plaintext))
	copy(output, frame[:prefix])
	copy(output[prefix:], plaintext)
	clear(plaintext)
	return output, nil
}

func (d *Decoder) Remove(kid uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.remove(kid)
}

func (d *Decoder) Destroy() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.destroy()
}

func (d *Decoder) current(now int64) error {
	if d.closed {
		return ErrClosed
	}
	if now < d.lastNow || now >= d.expiresAt {
		d.destroy()
		return ErrClosed
	}
	d.lastNow = now
	for kid, entry := range d.keys {
		if now >= entry.expiresAt {
			d.remove(kid)
		}
	}
	return nil
}

func (d *Decoder) remove(kid uint64) {
	if entry := d.keys[kid]; entry != nil {
		clear(entry.base[:])
		clear(entry.salt[:])
		entry.aead = nil
		entry.replay = replayWindow{}
		delete(d.keys, kid)
	}
}

func (d *Decoder) destroy() {
	d.closed = true
	for kid := range d.keys {
		d.remove(kid)
	}
	clear(d.seen)
}

func header(wire []byte) (kid, counter uint64, size int, err error) {
	if len(wire) == 0 {
		return 0, 0, 0, ErrFrame
	}
	config := wire[0]
	kw, cw := 0, 0
	if config&0x80 != 0 {
		kw = int((config>>4)&7) + 1
	}
	if config&8 != 0 {
		cw = int(config&7) + 1
	}
	size = 1 + kw + cw
	if len(wire) < size {
		return 0, 0, 0, ErrFrame
	}
	kid, counter = uint64((config>>4)&7), uint64(config&7)
	read := func(data []byte) (v uint64) {
		for _, b := range data {
			v = v<<8 | uint64(b)
		}
		return
	}
	if kw > 0 {
		kid = read(wire[1 : 1+kw])
		if kid <= 7 || kw > 1 && wire[1] == 0 {
			return 0, 0, 0, ErrFrame
		}
	}
	if cw > 0 {
		counter = read(wire[1+kw : size])
		if counter <= 7 || cw > 1 && wire[1+kw] == 0 {
			return 0, 0, 0, ErrFrame
		}
	}
	return
}

type replayWindow struct {
	highest     uint64
	bits        [2]uint64
	initialized bool
}

func (w *replayWindow) canAccept(counter uint64) bool {
	if !w.initialized || counter > w.highest {
		return true
	}
	distance := w.highest - counter
	return distance < 128 && w.bits[distance/64]&(uint64(1)<<(distance%64)) == 0
}

func (w *replayWindow) accept(counter uint64) {
	if !w.initialized {
		w.initialized = true
		w.highest = counter
		w.bits[0] = 1
		return
	}
	if counter > w.highest {
		distance := counter - w.highest
		switch {
		case distance >= 128:
			w.bits = [2]uint64{}
		case distance >= 64:
			w.bits[1], w.bits[0] = w.bits[0]<<(distance-64), 0
		default:
			w.bits[1] = w.bits[1]<<distance | w.bits[0]>>(64-distance)
			w.bits[0] <<= distance
		}
		w.highest = counter
	}
	distance := w.highest - counter
	w.bits[distance/64] |= uint64(1) << (distance % 64)
}
