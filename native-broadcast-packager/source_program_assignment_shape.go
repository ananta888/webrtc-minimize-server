package main

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

// Local v4 shape parser, deliberately separate from legacy wire decoding.
// Known object/array levels and the outer byte budget bound all traversal.
func validSourceProgramAssignmentShape(raw []byte) bool {
	if len(raw) == 0 || len(raw) > maximumSourceProgramAssignmentBytes || !utf8.Valid(raw) {
		return false
	}
	top, ok := sourceProgramExactObject(raw, "version", "type", "inputMode", "assignmentId", "roomId", "programId",
		"programEpoch", "leaseId", "fencingRevision", "resourceRef", "profile", "iceServers", "expiresAt", "sourceContext")
	if !ok {
		return false
	}
	if _, ok = sourceProgramExactObject(top["sourceContext"], "schema", "tenantId", "roomEpoch", "granteeDeviceRef", "frameEnvelope"); !ok {
		return false
	}
	profile, ok := sourceProgramExactObject(top["profile"], "profileId", "videoEncoder", "softwareFallback", "maximumQueueFrames", "keyframeIntervalSeconds", "renditions")
	if !ok {
		return false
	}
	var renditions, servers []json.RawMessage
	if json.Unmarshal(profile["renditions"], &renditions) != nil || len(renditions) < 1 || len(renditions) > 3 ||
		json.Unmarshal(top["iceServers"], &servers) != nil || servers == nil || len(servers) > 24 {
		return false
	}
	for _, rendition := range renditions {
		if _, ok = sourceProgramExactObject(rendition, "id", "width", "height", "framesPerSecond", "videoBitsPerSecond", "audioBitsPerSecond"); !ok {
			return false
		}
	}
	for _, server := range servers {
		var fields map[string]json.RawMessage
		if json.Unmarshal(server, &fields) != nil {
			return false
		}
		keys := []string{"urls"}
		if len(fields) != 1 {
			keys = append(keys, "username", "credential", "credentialType")
		}
		if _, ok = sourceProgramExactObject(server, keys...); !ok {
			return false
		}
	}
	return true
}

func sourceProgramExactObject(raw []byte, fields ...string) (map[string]json.RawMessage, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return nil, false
	}
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	values := make(map[string]json.RawMessage, len(fields))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, false
		}
		key, ok := token.(string)
		if !ok || !allowed[key] {
			return nil, false
		}
		if _, exists := values[key]; exists {
			return nil, false
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, false
		}
		values[key] = value
	}
	last, err := decoder.Token()
	if err != nil || last != json.Delim('}') || len(values) != len(fields) {
		return nil, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, false
	}
	return values, true
}
