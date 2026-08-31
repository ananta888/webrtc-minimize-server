package main

import (
	"net"

	"github.com/pion/turn/v5"
)

func newPermissionHandler(allowPrivate bool) turn.PermissionHandler {
	return func(_ net.Addr, peerIP net.IP) bool {
		if peerIP == nil || !peerIP.IsGlobalUnicast() || peerIP.IsUnspecified() || peerIP.IsLoopback() ||
			peerIP.IsLinkLocalUnicast() || peerIP.IsLinkLocalMulticast() || peerIP.IsMulticast() {
			return false
		}
		return allowPrivate || !peerIP.IsPrivate()
	}
}
