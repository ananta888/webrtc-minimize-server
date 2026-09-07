package trustedsframe

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"testing"
)

const now = int64(1_700_000_000_000)

var base = []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}

func fromHex(t *testing.T, value string) []byte {
	t.Helper()
	b, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func decoder(t *testing.T, codec string, kid uint64) *Decoder {
	t.Helper()
	d, err := New(Envelope, codec, now, now+120_000)
	if err != nil {
		t.Fatal(err)
	}
	if err = d.Install(kid, base, now, now+60_000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Destroy)
	return d
}

// Only a test encoder. Production contains no arbitrary source encryption API.
func frame(t *testing.T, d *Decoder, kid, counter uint64, keyframe bool) ([]byte, []byte) {
	t.Helper()
	integer := func(v uint64) []byte {
		out := []byte{byte(v)}
		for v >>= 8; v > 0; v >>= 8 {
			out = append([]byte{byte(v)}, out...)
		}
		return out
	}
	config := byte(0)
	kb, cb := []byte(nil), []byte(nil)
	if kid <= 7 {
		config |= byte(kid) << 4
	} else {
		kb = integer(kid)
		config |= 0x80 | byte(len(kb)-1)<<4
	}
	if counter <= 7 {
		config |= byte(counter)
	} else {
		cb = integer(counter)
		config |= 8 | byte(len(cb)-1)
	}
	header := append(append([]byte{config}, kb...), cb...)
	prefix, id := []byte{1, 0, 0}, byte(1)
	if keyframe {
		prefix = []byte{0, 0, 0, 0x9d, 1, 0x2a, 64, 0, 64, 0}
	}
	if d.codec == "audio/opus" {
		prefix = []byte{0x78}
		id = 2
	}
	metadata := []byte{0x53, 0x46, 1, id}
	aad := append(append(append([]byte{}, header...), metadata...), prefix...)
	entry := d.keys[kid]
	nonce := entry.salt
	for i, v := 11, counter; v > 0; i, v = i-1, v>>8 {
		nonce[i] ^= byte(v)
	}
	payload := []byte{4, 5, 6, 7, 8}
	ciphertext := entry.aead.Seal(nil, nonce[:], payload, aad)
	return append(append(append(append([]byte{}, prefix...), metadata...), header...), ciphertext...), append(append([]byte{}, prefix...), payload...)
}

func TestExistingSuite4Vector(t *testing.T) {
	d := decoder(t, "audio/opus", 291)
	wire := fromHex(t, "9901234567b7412c2513a1b66dbb48841bbaf17f598751176ad847681a69c6d0b091c07018ce4adb34eb")
	kid, counter, n, err := header(wire)
	if err != nil || kid != 291 || counter != 17767 {
		t.Fatal("vector header", err)
	}
	entry := d.keys[kid]
	nonce := entry.salt
	nonce[10] ^= 0x45
	nonce[11] ^= 0x67
	aad := append(append([]byte{}, wire[:n]...), fromHex(t, "4945544620534672616d65205747")...)
	plain, err := entry.aead.Open(nil, nonce[:], wire[n:], aad)
	if err != nil || !bytes.Equal(plain, fromHex(t, "64726166742d696574662d736672616d652d656e63")) {
		t.Fatal("suite-4 vector", err)
	}
}

func TestLongCounterAndAuthenticatedPrefix(t *testing.T) {
	for _, codec := range []string{"video/vp8", "audio/opus"} {
		t.Run(codec, func(t *testing.T) {
			d := decoder(t, codec, 0x123456789abcdef0)
			for ctr := uint64(0); ctr <= 400; ctr++ {
				wire, plain := frame(t, d, 0x123456789abcdef0, ctr, ctr%30 == 0)
				out, err := d.Decrypt(wire, now+int64(ctr))
				if err != nil || !bytes.Equal(out, plain) {
					t.Fatalf("counter %d: %v", ctr, err)
				}
				if _, err = d.Decrypt(wire, now+int64(ctr)); err != ErrReplay {
					t.Fatal("duplicate", err)
				}
			}
			wire, _ := frame(t, d, 0x123456789abcdef0, 401, false)
			bad := bytes.Clone(wire)
			bad[0] ^= 2
			if _, err := d.Decrypt(bad, now+500); err != ErrAuthentication {
				t.Fatal("prefix", err)
			}
			bad = bytes.Clone(wire)
			bad[len(bad)-1] ^= 1
			if _, err := d.Decrypt(bad, now+500); err != ErrAuthentication {
				t.Fatal("tag", err)
			}
			if _, err := d.Decrypt(wire, now+500); err != nil {
				t.Fatal("tamper poisoned replay", err)
			}
		})
	}
}

func TestReorderingConcurrentDuplicatesAndReinstall(t *testing.T) {
	d := decoder(t, "audio/opus", 7)
	wire, _ := frame(t, d, 7, 200, false)
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := d.Decrypt(wire, now); err == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatal("duplicate plaintexts", successes.Load())
	}
	if err := d.Install(7, base, now, now+60_000); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Decrypt(wire, now); err != ErrReplay {
		t.Fatal("reinstall reset replay", err)
	}
	other := bytes.Clone(base)
	other[0] ^= 1
	if d.Install(7, other, now, now+60_000) != ErrKey || d.Install(7, base, now, now+50_000) != ErrKey {
		t.Fatal("key replacement accepted")
	}
	for _, ctr := range []uint64{199, 73} {
		wire, _ = frame(t, d, 7, ctr, false)
		if _, err := d.Decrypt(wire, now); err != nil {
			t.Fatal(ctr, err)
		}
	}
	for _, ctr := range []uint64{199, 72} {
		wire, _ = frame(t, d, 7, ctr, false)
		if _, err := d.Decrypt(wire, now); err != ErrReplay {
			t.Fatal(ctr, err)
		}
	}
	d.Remove(7)
	if d.Install(7, base, now, now+60_000) != ErrKey {
		t.Fatal("removed KID revived")
	}
	if _, err := d.Decrypt(wire, now); err != ErrKey {
		t.Fatal(err)
	}
}

func TestBoundsExpiryAndCleanup(t *testing.T) {
	for _, codec := range []string{"video/h264", "", "audio/OPUS"} {
		if _, err := New(Envelope, codec, now, now+10000); err == nil {
			t.Fatal(codec)
		}
	}
	if _, err := New("codec-prefix-v2", "audio/opus", now, now+10000); err == nil {
		t.Fatal("unknown envelope")
	}
	d := decoder(t, "audio/opus", 1)
	for i := uint64(2); i <= 4; i++ {
		if err := d.Install(i, base, now, now+60000); err != nil {
			t.Fatal(err)
		}
	}
	if d.Install(5, base, now, now+60000) != ErrKey || d.Install(6, base[:15], now, now+60000) != ErrKey {
		t.Fatal("key bound")
	}
	wire, _ := frame(t, d, 1, 1, false)
	if _, err := d.Decrypt(make([]byte, MaxFrameBytes+1), now); err != ErrFrame {
		t.Fatal("frame bound")
	}
	entry := d.keys[1]
	if _, err := d.Decrypt(wire, now+60000); err != ErrKey {
		t.Fatal("key expiry", err)
	}
	if entry.aead != nil || entry.base != [16]byte{} || entry.salt != [12]byte{} {
		t.Fatal("reachable material retained")
	}
	if d.Install(1, base, now+60000, now+110000) != ErrKey {
		t.Fatal("expired KID revived")
	}
	if _, err := d.Decrypt(wire, now+120000); err != ErrClosed {
		t.Fatal("consent expiry", err)
	}
	if d.Install(9, base, now+120000, now+150000) != ErrClosed {
		t.Fatal("expired decoder revived")
	}
	fresh := decoder(t, "audio/opus", 1)
	if _, err := fresh.Decrypt(wire, now-1); err != ErrClosed {
		t.Fatal("clock rollback", err)
	}
	if _, err := fresh.Decrypt(wire, now); err != ErrClosed {
		t.Fatal("rollback revived", err)
	}
	fresh.Destroy()
	fresh.Destroy()
}

func TestHeaderRejectsAmbiguity(t *testing.T) {
	for _, wire := range [][]byte{nil, {0x80}, {0x80, 7}, {0x90, 0, 8}, {8, 7}, {9, 0, 8}, {0xff, 1}} {
		if _, _, _, err := header(wire); err == nil {
			t.Fatalf("accepted %x", wire)
		}
	}
	for _, ctr := range []uint64{0, 7, 8, 255, 256, 65535, 65536, ^uint64(0)} {
		d := decoder(t, "audio/opus", ^uint64(0))
		wire, plain := frame(t, d, ^uint64(0), ctr, false)
		out, err := d.Decrypt(wire, now)
		if err != nil || !bytes.Equal(out, plain) {
			t.Fatal(ctr, err)
		}
	}
}

func TestEnvelopeRejectionAndBoundedRotation(t *testing.T) {
	d := decoder(t, "audio/opus", 1)
	wire, _ := frame(t, d, 1, 9, false)
	for i := 0; i < len(wire); i++ {
		if _, err := d.Decrypt(wire[:i], now); err == nil {
			t.Fatal("truncated frame accepted", i)
		}
	}
	for _, offset := range []int{1, 2, 3, 4} {
		bad := bytes.Clone(wire)
		bad[offset] ^= 1
		if _, err := d.Decrypt(bad, now); err != ErrFrame {
			t.Fatal("unknown envelope/codec accepted", offset, err)
		}
	}
	if _, err := d.Decrypt(wire, now); err != nil {
		t.Fatal("malformed input poisoned receiver", err)
	}
	d.Remove(1)
	for kid := uint64(2); kid <= 512; kid++ {
		if err := d.Install(kid, base, now, now+60_000); err != nil {
			t.Fatal("rotation", err)
		}
		d.Remove(kid)
	}
	if len(d.keys) != 0 || len(d.seen) != 512 || d.Install(513, base, now, now+60_000) != ErrKey {
		t.Fatal("unbounded key history")
	}
}

func FuzzDecoderFrames(f *testing.F) {
	f.Add([]byte{0x78, 0x53, 0x46, 1, 2, 0xff})
	f.Add([]byte{0, 0, 0, 0x9d, 1, 0x2a, 64, 0, 64, 0, 0x53, 0x46, 1, 1, 0x88, 8, 8})
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, frame []byte) {
		for _, codec := range []string{"audio/opus", "video/vp8"} {
			d := decoder(t, codec, 1)
			output, err := d.Decrypt(frame, now)
			if err != nil && output != nil {
				t.Fatal("plaintext on rejection")
			}
			if err == nil && len(output) > MaxFrameBytes {
				t.Fatal("unbounded plaintext")
			}
		}
	})
}

// Invoked by the actual Chromium/Firefox WebCrypto gate, with synthetic test
// bytes through stdin. No fixture secrets or decrypted content are logged.
func TestBrowserInterop(t *testing.T) {
	if os.Getenv("TRUSTED_SFRAME_BROWSER_INTEROP") != "1" {
		t.Skip("requires explicit browser-generated stdin fixture")
	}
	var input struct {
		Codec  string
		Base   string
		KID    uint64
		Frames []struct {
			Wire  string
			Plain string
		}
	}
	r := json.NewDecoder(io.LimitReader(os.Stdin, 4*1024*1024))
	r.DisallowUnknownFields()
	if err := r.Decode(&input); err != nil {
		t.Fatal("invalid browser fixture")
	}
	if len(input.Frames) != 401 {
		t.Fatal("counter-400 evidence missing")
	}
	d, err := New(Envelope, input.Codec, now, now+60000)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Destroy()
	if err = d.Install(input.KID, fromHex(t, input.Base), now, now+60000); err != nil {
		t.Fatal(err)
	}
	for i, f := range input.Frames {
		wire := fromHex(t, f.Wire)
		out, err := d.Decrypt(wire, now+int64(i))
		if err != nil || !bytes.Equal(out, fromHex(t, f.Plain)) {
			t.Fatalf("browser frame %d: %v", i, err)
		}
	}
	if _, err = d.Decrypt(fromHex(t, input.Frames[400].Wire), now+400); err != ErrReplay {
		t.Fatal("browser replay")
	}
}
