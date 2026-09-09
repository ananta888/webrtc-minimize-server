package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const sourceHLSEpochLimit = 128
const sourceHLSEpochSpan = uint64(1_000_000)

// Local encoder identity only. It does not change a writer lease or source grant.
// Each generation gets disjoint media sequence numbers, never a cyclic filename.
type sourceHLSEpoch uint32

func (e sourceHLSEpoch) valid() bool   { return e < sourceHLSEpochLimit }
func (e sourceHLSEpoch) start() uint64 { return uint64(e) * sourceHLSEpochSpan }

func (e sourceHLSEpoch) playlist(data []byte, init string) (sourceHLSPlaylist, error) {
	bad := errors.New("source HLS epoch mismatch")
	if !e.valid() {
		return sourceHLSPlaylist{}, bad
	}
	p, err := sourceHLSParsePlaylist(data, init)
	if err != nil {
		return sourceHLSPlaylist{}, err
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	var sequence uint64
	for _, line := range lines {
		if strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:") {
			sequence, err = strconv.ParseUint(strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"), 10, 64)
			if err != nil || sequence < e.start() || sequence >= e.start()+sourceHLSEpochSpan {
				return sourceHLSPlaylist{}, bad
			}
		}
	}
	for i, file := range p.media[1:] {
		n, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(file, "segment_"), ".m4s"), 10, 64)
		if err != nil || n != sequence+uint64(i) || n >= e.start()+sourceHLSEpochSpan || file != fmt.Sprintf("segment_%09d.m4s", n) {
			return sourceHLSPlaylist{}, bad
		}
	}
	p.window = sourceHLSWindow{first: sequence, last: sequence + uint64(len(p.media)-2)}
	if e == 0 {
		return p, nil
	}
	// Only the first segment of this new timeline carries the discontinuity.
	// Once it leaves the rolling window, retain its count in the sequence tag.
	discontinuity := uint32(e)
	first := sequence == e.start()
	if first {
		discontinuity--
	}
	var out strings.Builder
	for _, line := range lines {
		if strings.HasPrefix(line, "#EXT-X-MAP:") {
			fmt.Fprintf(&out, "#EXT-X-DISCONTINUITY-SEQUENCE:%d\n", discontinuity)
			if first {
				out.WriteString("#EXT-X-DISCONTINUITY\n")
			}
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	if out.Len() > 65536 {
		return sourceHLSPlaylist{}, bad
	}
	p.data = []byte(out.String())
	return p, nil
}
