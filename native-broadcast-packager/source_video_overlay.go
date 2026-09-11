package main

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	overlayTitleMax   = 100
	overlayCaptionMax = 240
	overlayLabelMax   = 32
	overlayLabelCount = 20
)

// Local presentation only. Default is off. Never room, peer, grant or lease IDs.
type sourceVideoOverlay struct {
	ShowLabels, ShowTitle, ShowCaptions bool
	Title, Caption, CaptionStyle        string
	Labels                              []string
	CaptionPositionPercent              int
}

func emptySourceVideoOverlay() sourceVideoOverlay {
	return sourceVideoOverlay{CaptionStyle: "high-contrast", CaptionPositionPercent: 88}
}

func overlayLooksLikeIdentifier(value string) bool {
	if value == "" {
		return false
	}
	lower := strings.ToLower(value)
	for _, prefix := range []string{"room-", "prg_", "tn_", "src_", "pkr_", "asn_", "ms_", "sub_", "sls_", "cns_", "lea_"} {
		if strings.Contains(lower, prefix) {
			return true
		}
	}
	return false
}

func overlayBoundedText(value string, maximum int) (string, error) {
	if utf8.RuneCountInString(value) > maximum || strings.ContainsRune(value, 0) || overlayLooksLikeIdentifier(value) {
		return "", errors.New("source video overlay text denied")
	}
	for _, r := range value {
		if r < 32 || r == 127 || unicode.IsControl(r) {
			return "", errors.New("source video overlay text denied")
		}
	}
	return value, nil
}

func normalizeSourceVideoOverlay(value sourceVideoOverlay) (sourceVideoOverlay, error) {
	if value.CaptionStyle == "" {
		value.CaptionStyle = "high-contrast"
	}
	if value.CaptionPositionPercent == 0 {
		value.CaptionPositionPercent = 88
	}
	if !oneOf(value.CaptionStyle, "high-contrast", "subtle", "large") ||
		value.CaptionPositionPercent < 10 || value.CaptionPositionPercent > 95 ||
		len(value.Labels) > overlayLabelCount {
		return sourceVideoOverlay{}, errors.New("source video overlay denied")
	}
	title, err := overlayBoundedText(value.Title, overlayTitleMax)
	if err != nil {
		return sourceVideoOverlay{}, err
	}
	caption, err := overlayBoundedText(value.Caption, overlayCaptionMax)
	if err != nil {
		return sourceVideoOverlay{}, err
	}
	labels := make([]string, len(value.Labels))
	for i, label := range value.Labels {
		if labels[i], err = overlayBoundedText(label, overlayLabelMax); err != nil {
			return sourceVideoOverlay{}, err
		}
	}
	if !value.ShowTitle {
		title = ""
	}
	if !value.ShowCaptions {
		caption = ""
	}
	if !value.ShowLabels {
		labels = nil
	}
	return sourceVideoOverlay{
		ShowLabels: value.ShowLabels, ShowTitle: value.ShowTitle, ShowCaptions: value.ShowCaptions,
		Title: title, Caption: caption, CaptionStyle: value.CaptionStyle,
		Labels: labels, CaptionPositionPercent: value.CaptionPositionPercent,
	}, nil
}

func (m *sourceVideoMixer) SetOverlay(expected uint64, overlay sourceVideoOverlay) (uint64, error) {
	normalized, err := normalizeSourceVideoOverlay(overlay)
	if err != nil {
		return 0, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || !m.cfg.authorized() {
		m.closeLocked()
		if m.revision == 0 {
			return 0, errors.New("source video mixer closed")
		}
		return m.revision, errors.New("source video mixer closed")
	}
	if expected != m.revision || m.revision >= sourceVideoSceneMaxRevision {
		return m.revision, errors.New("source video overlay conflict")
	}
	m.overlay = normalized
	m.revision++
	return m.revision, nil
}

func (p *sourceProgramGeneration) SetOverlay(expected uint64, overlay sourceVideoOverlay) (uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.permitted() || p.video == nil {
		return 0, errors.New("source program overlay denied")
	}
	return p.video.SetOverlay(expected, overlay)
}

func paintSourceVideoOverlay(pixels []byte, width, height int, overlay sourceVideoOverlay, rects []sourceVideoRect) {
	if len(pixels) != width*height*4 {
		return
	}
	fg, bar := byte(255), byte(0)
	if overlay.CaptionStyle == "subtle" {
		fg, bar = 220, 40
	}
	if overlay.ShowTitle && overlay.Title != "" {
		fillOverlayBar(pixels, width, 0, 0, width, min(height, 11), bar)
		drawOverlayText(pixels, width, height, 2, 2, overlay.Title, fg, 1)
	}
	if overlay.ShowCaptions && overlay.Caption != "" {
		scale := 1
		if overlay.CaptionStyle == "large" {
			scale = 2
		}
		textHeight := 7*scale + 4
		centerY := height * overlay.CaptionPositionPercent / 100
		top := min(height-textHeight, max(0, centerY-textHeight/2))
		fillOverlayBar(pixels, width, 0, top, width, textHeight, bar)
		drawOverlayText(pixels, width, height, 4, top+2, overlay.Caption, fg, scale)
	}
	if overlay.ShowLabels {
		for i, rect := range rects {
			if i >= len(overlay.Labels) || overlay.Labels[i] == "" || rect.width < 8 || rect.height < 10 {
				continue
			}
			top := rect.y + rect.height - 9
			fillOverlayBar(pixels, width, rect.x, top, rect.width, min(9, rect.height), bar)
			drawOverlayText(pixels, width, height, rect.x+1, top+1, overlay.Labels[i], fg, 1)
		}
	}
}

func fillOverlayBar(pixels []byte, stride, x, y, width, height int, gray byte) {
	for row := y; row < y+height; row++ {
		for column := x; column < x+width; column++ {
			i := (row*stride + column) * 4
			pixels[i], pixels[i+1], pixels[i+2], pixels[i+3] = gray, gray, gray, 255
		}
	}
}

func drawOverlayText(pixels []byte, width, height, x, y int, text string, gray byte, scale int) {
	if scale < 1 {
		scale = 1
	}
	cursor := x
	for _, r := range text {
		if cursor+5*scale > width {
			return
		}
		cols, ok := overlayGlyph(r)
		if !ok {
			cursor += 6 * scale
			continue
		}
		for col := 0; col < 5; col++ {
			bits := cols[col]
			for row := 0; row < 7; row++ {
				if bits&(1<<row) == 0 {
					continue
				}
				for dy := 0; dy < scale; dy++ {
					py := y + row*scale + dy
					if py < 0 || py >= height {
						continue
					}
					for dx := 0; dx < scale; dx++ {
						px := cursor + col*scale + dx
						if px < 0 || px >= width {
							continue
						}
						i := (py*width + px) * 4
						pixels[i], pixels[i+1], pixels[i+2], pixels[i+3] = gray, gray, gray, 255
					}
				}
			}
		}
		cursor += 6 * scale
	}
}

func overlayGlyph(r rune) ([5]byte, bool) {
	if r >= 'a' && r <= 'z' {
		r -= 32
	}
	switch r {
	case ' ':
		return [5]byte{}, true
	case 'H':
		return [5]byte{0x7f, 0x08, 0x08, 0x08, 0x7f}, true
	case 'I':
		return [5]byte{0x41, 0x41, 0x7f, 0x41, 0x41}, true
	case 'A':
		return [5]byte{0x3e, 0x09, 0x09, 0x09, 0x3e}, true
	case 'E':
		return [5]byte{0x7f, 0x49, 0x49, 0x49, 0x41}, true
	case 'L':
		return [5]byte{0x7f, 0x40, 0x40, 0x40, 0x40}, true
	case 'O':
		return [5]byte{0x3e, 0x41, 0x41, 0x41, 0x3e}, true
	case 'T':
		return [5]byte{0x01, 0x01, 0x7f, 0x01, 0x01}, true
	case '-':
		return [5]byte{0x08, 0x08, 0x08, 0x08, 0x08}, true
	default:
		if r >= 32 && r <= 126 {
			return [5]byte{0x7f, 0x41, 0x41, 0x41, 0x7f}, true
		}
		return [5]byte{}, false
	}
}
