package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"time"
	"unicode/utf8"
)

const maximumSourceAudioControlBytes = 16 * 1024
const maximumSourceAudioControlHistory = 32

var sourceAudioCommandID = regexp.MustCompile(`^aud_[A-Za-z0-9_-]{16,64}$`)
var sourceAudioLeaseID = regexp.MustCompile(`^sls_[A-Za-z0-9_-]{16,64}$`)

type sourceAudioControlScope struct {
	Version         int    `json:"version"`
	Type            string `json:"type"`
	CommandID       string `json:"commandId"`
	AssignmentID    string `json:"assignmentId"`
	ProgramID       string `json:"programId"`
	ProgramEpoch    int64  `json:"programEpoch"`
	LeaseID         string `json:"leaseId"`
	FencingRevision int64  `json:"fencingRevision"`
}

type sourceAudioQuery struct {
	sourceAudioControlScope
	IssuedAt  int64 `json:"issuedAt"`
	ExpiresAt int64 `json:"expiresAt"`
}

type sourceAudioCommand struct {
	sourceAudioQuery
	ExpectedAudioRevision uint64                    `json:"expectedAudioRevision"`
	Sources               []sourceProgramAudioLevel `json:"sources"`
}

type sourceAudioReceipt struct {
	sourceAudioControlScope
	AudioRevision uint64 `json:"audioRevision"`
	AppliedAt     int64  `json:"appliedAt"`
}

type sourceAudioReply struct {
	sourceAudioControlScope
	sourceProgramAudioState
	ObservedAt int64 `json:"observedAt"`
}

func exactAudioObject(raw []byte, fields ...string) (map[string]json.RawMessage, bool) {
	value, ok := sourceProgramExactObject(raw, fields...)
	if !ok {
		return nil, false
	}
	for _, field := range value {
		if bytes.Equal(bytes.TrimSpace(field), []byte("null")) {
			return nil, false
		}
	}
	return value, true
}

func audioControlFields() []string {
	return []string{"version", "type", "commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision", "issuedAt", "expiresAt"}
}

func validAudioQuery(q sourceAudioQuery, kind string, now time.Time) bool {
	const maximum int64 = 9007199254740991
	n := now.UnixMilli()
	return q.Version == 1 && q.Type == kind && sourceAudioCommandID.MatchString(q.CommandID) &&
		assignmentIDPattern.MatchString(q.AssignmentID) && programIDPattern.MatchString(q.ProgramID) && leaseIDPattern.MatchString(q.LeaseID) &&
		q.ProgramEpoch >= 1 && q.ProgramEpoch <= maximum && q.FencingRevision >= 1 && q.FencingRevision <= maximum &&
		q.IssuedAt >= 1 && q.IssuedAt <= maximum && q.ExpiresAt >= 1 && q.ExpiresAt <= maximum && n >= 1 && n <= maximum &&
		q.IssuedAt <= n+1000 && q.ExpiresAt > n && q.ExpiresAt > q.IssuedAt && q.ExpiresAt-q.IssuedAt <= 4000
}

func parseSourceAudioQuery(raw []byte, now time.Time) (sourceAudioQuery, error) {
	var q sourceAudioQuery
	_, exact := exactAudioObjectBounded(raw, audioControlFields()...)
	if !exact || json.Unmarshal(raw, &q) != nil || !validAudioQuery(q, "source-program-audio-query", now) {
		return sourceAudioQuery{}, errors.New("invalid source audio query")
	}
	return q, nil
}

func exactAudioObjectBounded(raw []byte, fields ...string) (map[string]json.RawMessage, bool) {
	if len(raw) == 0 || len(raw) > maximumSourceAudioControlBytes || !utf8.Valid(raw) {
		return nil, false
	}
	return exactAudioObject(raw, fields...)
}

func parseSourceAudioCommand(raw []byte, now time.Time) (sourceAudioCommand, error) {
	var c sourceAudioCommand
	fail := func() (sourceAudioCommand, error) {
		return sourceAudioCommand{}, errors.New("invalid source audio command")
	}
	fields, exact := exactAudioObjectBounded(raw, append(audioControlFields(), "expectedAudioRevision", "sources")...)
	if !exact || json.Unmarshal(raw, &c) != nil || !validAudioQuery(c.sourceAudioQuery, "source-program-audio", now) ||
		c.ExpectedAudioRevision < 1 || c.ExpectedAudioRevision >= sourceAudioLevelMaxRevision || len(c.Sources) < 1 || len(c.Sources) > 80 {
		return fail()
	}
	var sources []json.RawMessage
	if json.Unmarshal(fields["sources"], &sources) != nil {
		return fail()
	}
	seen := make(map[string]bool, len(c.Sources))
	for i, s := range c.Sources {
		if _, exact := exactAudioObject(sources[i], "sourceLeaseId", "leftGainQ15", "rightGainQ15", "muted"); !exact ||
			!sourceAudioLeaseID.MatchString(s.SourceLeaseID) || seen[s.SourceLeaseID] || !validSourceAudioGain(s.Left, s.Right) {
			return fail()
		}
		seen[s.SourceLeaseID] = true
	}
	return c, nil
}
