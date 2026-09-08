package main

import (
	"errors"
	"regexp"
	"strings"

	"github.com/pion/sdp/v3"
)

var sourceWireTrackPattern = regexp.MustCompile(`^[A-Za-z0-9_={}:-]{1,128}$`)

// The authorized room publication ID is not necessarily the browser's SDP
// sender-track ID (notably Firefox). Resolve exactly one consistent transport
// label inside this already source-bound offer; it grants no new source rights.
func sourceOfferTrack(raw, codec string) (string, error) {
	if !sourceOfferShape(raw, codec) {
		return "", errors.New("source media shape")
	}
	var description sdp.SessionDescription
	if description.Unmarshal([]byte(raw)) != nil {
		return "", errors.New("source SDP syntax")
	}
	id, stream := "", ""
	media := false
	accept := func(value string) bool {
		fields := strings.Fields(value)
		if len(fields) != 2 || fields[1] == "-" || !sourceWireTrackPattern.MatchString(fields[1]) || len(fields[0]) > 128 {
			return false
		}
		if id != "" && (id != fields[1] || stream != fields[0]) {
			return false
		}
		stream, id = fields[0], fields[1]
		return true
	}
	for _, section := range description.MediaDescriptions {
		if section.MediaName.Media == "application" {
			continue
		}
		media = true
		for _, attribute := range section.Attributes {
			if attribute.Key == "msid" && !accept(attribute.Value) {
				return "", errors.New("ambiguous source MSID")
			}
			if attribute.Key == "ssrc" {
				parts := strings.SplitN(attribute.Value, " ", 2)
				if len(parts) == 2 && strings.HasPrefix(parts[1], "msid:") && !accept(strings.TrimPrefix(parts[1], "msid:")) {
					return "", errors.New("ambiguous source SSRC MSID")
				}
			}
		}
	}
	if media && id == "" {
		return "", errors.New("source track ID missing")
	}
	return id, nil
}
