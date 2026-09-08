package main

import "errors"

type sourceVideoRect struct {
	source, x, y, width, height int
}

// Geometry only: input indices are already-authorized local scene slots.
func sourceVideoSceneRects(layout string, kinds []string, width, height, active int) ([]sourceVideoRect, error) {
	if !oneOf(layout, "single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate") ||
		width < 32 || width > 1920 || height < 20 || height > 1080 || len(kinds) > 20 || active < -1 || active >= len(kinds) {
		return nil, errors.New("source video scene layout denied")
	}
	for _, kind := range kinds {
		if !oneOf(kind, "camera", "screen") {
			return nil, errors.New("source video scene kind denied")
		}
	}
	if len(kinds) == 0 || layout == "waiting-slate" || layout == "end-slate" {
		return nil, nil
	}
	if active < 0 {
		active = 0
	}
	full := func(index int) sourceVideoRect { return sourceVideoRect{source: index, width: width, height: height} }
	if layout == "single" {
		return []sourceVideoRect{full(active)}, nil
	}
	if layout == "screen-presenter" {
		screen, camera := 0, -1
		for i, kind := range kinds {
			if kind == "screen" {
				screen = i
				break
			}
		}
		for i, kind := range kinds {
			if kind == "camera" && i != screen {
				camera = i
				break
			}
		}
		rects := []sourceVideoRect{full(screen)}
		if camera >= 0 {
			padding := min(max(1, width*2/100), (height-2)/2)
			w := max(2, width*22/100)
			h := min(height-padding*2, max(2, w*9/16))
			rects = append(rects, sourceVideoRect{camera, width - w - padding, height - h - padding, w, h})
		}
		return rects, nil
	}
	if layout == "active-speaker" {
		if len(kinds) == 1 {
			return []sourceVideoRect{full(active)}, nil
		}
		strip := max(2, width*22/100)
		rects := []sourceVideoRect{{active, 0, 0, width - strip, height}}
		row := 0
		for i := range kinds {
			if i == active {
				continue
			}
			top, bottom := height*row/(len(kinds)-1), height*(row+1)/(len(kinds)-1)
			rects = append(rects, sourceVideoRect{i, width - strip, top, strip, bottom - top})
			row++
		}
		return rects, nil
	}
	columns := 1
	for columns*columns < len(kinds) {
		columns++
	}
	if layout == "side-by-side" {
		columns = min(2, len(kinds))
	}
	rows := (len(kinds) + columns - 1) / columns
	rects := make([]sourceVideoRect, len(kinds))
	for i := range kinds {
		column, row := i%columns, i/columns
		left, top := width*column/columns, height*row/rows
		rects[i] = sourceVideoRect{i, left, top, width*(column+1)/columns - left, height*(row+1)/rows - top}
	}
	return rects, nil
}

func fillSourceVideoSlate(pixels []byte, stride, x, y, width, height int) {
	for row := y; row < y+height; row++ {
		for column := x; column < x+width; column++ {
			i := (row*stride + column) * 4
			pixels[i], pixels[i+1], pixels[i+2], pixels[i+3] = 9, 19, 31, 255
		}
	}
}

// Fixed-point bilinear sampling of opaque decoded VP8 pixels. No vendor SDK,
// remote URL, canvas, font, label, transcript or user-supplied filter string.
// The centered crop/letterbox never samples another source's rectangle.
func blitSourceVideo(output []byte, stride int, rect sourceVideoRect, width, height int, fit string, pixels []byte) {
	if rect.width == 0 || rect.height == 0 {
		return
	}
	cropX, cropY, cropW, cropH := 0, 0, width, height
	if fit == "contain" {
		w, h := rect.width, rect.height
		if width*rect.height > height*rect.width {
			h = max(1, rect.width*height/width)
		} else {
			w = max(1, rect.height*width/height)
		}
		rect.x, rect.y = rect.x+(rect.width-w)/2, rect.y+(rect.height-h)/2
		rect.width, rect.height = w, h
	} else {
		if width*rect.height > height*rect.width {
			cropW = max(1, height*rect.width/rect.height)
		} else {
			cropH = max(1, width*rect.height/rect.width)
		}
		cropX, cropY = (width-cropW)/2, (height-cropH)/2
	}
	// One fixed-size lookup per call, not per pixel or per source frame.
	var horizontal [1920]sourceVideoAxis
	for x := 0; x < rect.width; x++ {
		horizontal[x] = sourceVideoSampleAxis(x, rect.width, cropX, cropW)
	}
	for y := 0; y < rect.height; y++ {
		yaxis := sourceVideoSampleAxis(y, rect.height, cropY, cropH)
		for x := 0; x < rect.width; x++ {
			xaxis := horizontal[x]
			tl, tr := (yaxis.a*width+xaxis.a)*4, (yaxis.a*width+xaxis.b)*4
			bl, br := (yaxis.b*width+xaxis.a)*4, (yaxis.b*width+xaxis.b)*4
			dst := ((y+rect.y)*stride + x + rect.x) * 4
			for channel := 0; channel < 3; channel++ {
				top := int64(pixels[tl+channel])*(65536-xaxis.fraction) + int64(pixels[tr+channel])*xaxis.fraction
				bottom := int64(pixels[bl+channel])*(65536-xaxis.fraction) + int64(pixels[br+channel])*xaxis.fraction
				output[dst+channel] = byte((top*(65536-yaxis.fraction) + bottom*yaxis.fraction + 1<<31) >> 32)
			}
			output[dst+3] = 255
		}
	}
}

type sourceVideoAxis struct {
	a, b     int
	fraction int64
}

func sourceVideoSampleAxis(pixel, target, offset, length int) sourceVideoAxis {
	position := (int64(2*pixel+1)*int64(length)*65536)/(2*int64(target)) - 32768
	position = max(0, min(int64(length-1)*65536, position))
	a := int(position / 65536)
	return sourceVideoAxis{offset + a, offset + min(a+1, length-1), position % 65536}
}
