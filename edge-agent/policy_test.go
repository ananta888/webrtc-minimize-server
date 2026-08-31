package main

import (
	"net"
	"testing"
)

func TestPermissionPolicyDeniesNonPublicTargetsByDefault(t *testing.T) {
	strict := newPermissionHandler(false)
	for _, value := range []string{"0.0.0.0", "127.0.0.1", "10.0.0.1", "169.254.1.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1"} {
		if strict(nil, net.ParseIP(value)) {
			t.Fatalf("strict policy accepted %s", value)
		}
	}
	if !strict(nil, net.ParseIP("198.51.100.42")) {
		t.Fatal("strict policy rejected a public target")
	}
	lan := newPermissionHandler(true)
	if !lan(nil, net.ParseIP("10.0.0.1")) || lan(nil, net.ParseIP("127.0.0.1")) {
		t.Fatal("explicit LAN policy did not preserve special-address denial")
	}
}
