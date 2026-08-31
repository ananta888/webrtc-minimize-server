package main

import (
	"crypto/hmac"
	"crypto/sha1" // Coturn's TURN REST credential mechanism specifies HMAC-SHA1.
	"encoding/base64"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pion/turn/v5"
)

var opaquePrincipal = regexp.MustCompile(`^[a-f0-9]{20}$`)

type clock func() time.Time

func newRESTAuthHandler(cfg config, now clock) turn.AuthHandler {
	return func(attributes *turn.RequestAttributes) (string, []byte, bool) {
		if attributes == nil || attributes.Realm != cfg.realm {
			return "", nil, false
		}
		parts := strings.Split(attributes.Username, ":")
		if len(parts) != 2 || !opaquePrincipal.MatchString(parts[1]) {
			return "", nil, false
		}
		expiresAt, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return "", nil, false
		}
		current := now()
		expiry := time.Unix(expiresAt, 0)
		if !expiry.After(current) || expiry.After(current.Add(cfg.maxCredentialTTL)) {
			return "", nil, false
		}
		mac := hmac.New(sha1.New, []byte(cfg.sharedSecret)) // #nosec G401 -- required by TURN REST auth.
		_, _ = mac.Write([]byte(attributes.Username))
		password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		return parts[1], turn.GenerateAuthKey(attributes.Username, cfg.realm, password), true
	}
}
