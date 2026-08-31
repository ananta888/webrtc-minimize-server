package main

import (
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

func TestRESTAuthAcceptsOnlyFreshRealmBoundCredentials(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	cfg := config{
		realm:            "webrtc.example",
		sharedSecret:     "0123456789abcdef0123456789abcdef",
		maxCredentialTTL: 10 * time.Minute,
	}
	handler := newRESTAuthHandler(cfg, func() time.Time { return now })
	userID, key, ok := handler(&turn.RequestAttributes{
		Username: "1000300:0123456789abcdefabcd",
		Realm:    cfg.realm,
	})
	if !ok || userID != "0123456789abcdefabcd" || len(key) == 0 {
		t.Fatalf("valid credential was rejected")
	}
	for _, attributes := range []*turn.RequestAttributes{
		{Username: "999999:0123456789abcdefabcd", Realm: cfg.realm},
		{Username: "1000601:0123456789abcdefabcd", Realm: cfg.realm},
		{Username: "1000300:not-opaque", Realm: cfg.realm},
		{Username: "1000300:0123456789abcdefabcd", Realm: "other.example"},
		nil,
	} {
		if _, _, accepted := handler(attributes); accepted {
			t.Fatalf("unsafe credential was accepted: %#v", attributes)
		}
	}
}
