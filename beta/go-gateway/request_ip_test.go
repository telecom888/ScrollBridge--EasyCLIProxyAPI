package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestClientIPTrustAndNormalization(t *testing.T) {
	for _, tc := range []struct{ peer, cf, cf6, xff, want string }{
		{"127.0.0.1:1234", "2001:0db8::1", "", "", "2001:db8::1"},
		{"[::ffff:127.0.0.1]:1234", "::ffff:192.0.2.1", "", "", "192.0.2.1"},
		{"127.0.0.1:1", "", "", "198.51.100.1", "127.0.0.1"},
		{"192.0.2.1:2", "198.51.100.1", "", "", "192.0.2.1"},
		{"127.0.0.1:1", "240.1.2.3", "2001:db8::2", "", "2001:db8::2"},
		{"127.0.0.1:1", "192.0.2.1, 198.51.100.1", "", "", "127.0.0.1"},
	} {
		r := httptest.NewRequest("GET", "http://fixture/", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("CF-Connecting-IP", tc.cf)
		r.Header.Set("CF-Connecting-IPv6", tc.cf6)
		r.Header.Set("X-Forwarded-For", tc.xff)
		if got := clientIP(r); got != tc.want {
			t.Fatalf("clientIP=%q want %q", got, tc.want)
		}
	}
}
func TestIPBlacklistPrecedesAuthAndDoesNotDependOnLogging(t *testing.T) {
	var calls atomic.Int64
	g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.Write([]byte(`{"data":[]}`)) })
	c := g.current.Load().cfg
	c.Version++
	c.RecordRequestIP = false
	c.IPBlacklist = []string{"::ffff:192.0.2.1", "2001:0db8::1"}
	s, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(s); err != nil {
		t.Fatal(err)
	}
	var row map[string]any
	g.record = func(v map[string]any) { row = v }
	request := func(ip string) int {
		r := httptest.NewRequest("GET", "http://fixture/robots.txt", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("CF-Connecting-IP", ip)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		return w.Code
	}
	for _, ip := range []string{"192.0.2.1", "2001:db8:0:0::1"} {
		if got := request(ip); got != 403 {
			t.Fatalf("blocked %s status=%d", ip, got)
		}
		if row["requestIP"] != nil || row["reason"] != "IP 已屏蔽" {
			t.Fatal(row)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("blacklisted request reached upstream")
	}
	c = s.cfg
	c.Version++
	c.RecordRequestIP = true
	c.IPBlacklist = nil
	s, err = compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(s); err != nil {
		t.Fatal(err)
	}
	if request("2001:db8::1") != 401 || row["requestIP"] != "2001:db8::1" {
		t.Fatal(row)
	}
	for _, ip := range []string{"192.0.2.0/24", "fe80::1%eth0", "bad"} {
		bad := c
		bad.IPBlacklist = []string{ip}
		if _, err = compile(bad); err == nil {
			t.Fatal("invalid IP accepted", ip)
		}
	}
}
func TestIPLoggingSwitchDoesNotInvalidateActivePolicy(t *testing.T) {
	c := fixtureConfig("http://127.0.0.1:1234")
	a, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	c.RecordRequestIP = true
	b, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if a.accessSignature != b.accessSignature {
		t.Fatal("logging setting invalidates active connections")
	}
}

func TestIPBlacklistUpdateCancelsOnlyMatchingFlights(t *testing.T) {
	g, _, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {})
	blocked, other := false, false
	g.active[&flight{requestIP: "192.0.2.1", cancel: func() { blocked = true }}] = true
	g.active[&flight{requestIP: "192.0.2.2", cancel: func() { other = true }}] = true
	c := g.current.Load().cfg
	c.Version++
	c.IPBlacklist = []string{"192.0.2.1"}
	s, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(s); err != nil {
		t.Fatal(err)
	}
	if !blocked || other {
		t.Fatalf("flight cancellation: blocked=%v other=%v", blocked, other)
	}
}
