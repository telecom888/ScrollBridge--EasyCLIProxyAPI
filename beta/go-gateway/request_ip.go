package main

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

func normalizedIP(value string) (netip.Addr, bool) {
	ip, err := netip.ParseAddr(value)
	if err != nil || ip.Zone() != "" || value != strings.TrimSpace(value) {
		return netip.Addr{}, false
	}
	return ip.Unmap(), true
}
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return ""
	}
	peer, ok := normalizedIP(host)
	if !ok {
		return ""
	}
	if peer.IsLoopback() {
		values := r.Header.Values("CF-Connecting-IP")
		if len(values) == 1 {
			if ip, valid := normalizedIP(values[0]); valid {
				if ip.Is4() && ip.As4()[0] >= 240 {
					v6 := r.Header.Values("CF-Connecting-IPv6")
					if len(v6) == 1 {
						if original, valid := normalizedIP(v6[0]); valid && original.Is6() {
							return original.String()
						}
					}
				}
				return ip.String()
			}
		}
	}
	return peer.String()
}
