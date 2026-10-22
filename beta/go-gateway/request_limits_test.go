package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWebSocketTurnsShareHTTPConcurrencyAndRequestWindows(t *testing.T) {
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for i := 0; ; i++ {
			if _, _, err = ws.ReadMessage(); err != nil {
				return
			}
			id := "one"
			if i > 0 {
				id = "two"
			}
			if ws.WriteJSON(map[string]any{"type": "response.created", "response": map[string]any{"id": id}}) != nil {
				return
			}
			if i == 0 {
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			if ws.WriteJSON(map[string]any{"type": "response.completed", "response": map[string]any{"id": id}}) != nil {
				return
			}
		}
	})
	c := g.current.Load().cfg
	c.Version++
	c.Keys[0].Concurrent = 1
	c.Keys[0].RequestLimit = 2
	c.Keys[0].RequestWindowSeconds = 60
	n, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(n); err != nil {
		t.Fatal(err)
	}
	ws, _, err := websocket.DefaultDialer.Dial(strings.Replace(s.URL, "http", "ws", 1)+"/v1/responses", http.Header{"Authorization": []string{"Bearer " + testToken}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	send := func() {
		t.Helper()
		if err := ws.WriteJSON(map[string]any{"type": "response.create", "model": "chat-alias"}); err != nil {
			t.Fatal(err)
		}
	}
	read := func(kind string) {
		t.Helper()
		var v map[string]any
		if err := ws.ReadJSON(&v); err != nil {
			t.Fatal(err)
		}
		if v["type"] != kind {
			t.Fatalf("want %s got %v", kind, v)
		}
		if kind == "error" && v["status"] != float64(429) {
			t.Fatal(v)
		}
	}
	send()
	read("response.created")
	send()
	read("error")
	close(release)
	read("response.completed")
	send()
	read("response.created")
	read("response.completed")
	send()
	read("error")
}

func TestStreamBudgetFollowsObservedEventsAndIsReleased(t *testing.T) {
	for _, rejectGrowth := range []bool{false, true} {
		rec := httptest.NewRecorder()
		var held, peak int64
		budget := func(n int64) bool {
			if rejectGrowth && n > 0 {
				return false
			}
			held += n
			peak = max(peak, held)
			return true
		}
		data := "data: {\"model\":\"real-model\",\"text\":\"" + strings.Repeat("x", 16000) + "\"}\n\ndata: [DONE]\n\n"
		err := streamSSEBudget(&deadlineWriter{w: rec, seconds: 1, limit: 1 << 20}, strings.NewReader(data), entry{Name: "alias", Actual: "real-model"}, 256<<10, &usage{}, 0, budget)
		if held != 0 {
			t.Fatal("leaked stream reservation", held)
		}
		if rejectGrowth && err == nil {
			t.Fatal("growth bypassed shared budget")
		}
		if !rejectGrowth && (err != nil || peak == 0 || peak > 512<<10 || !strings.Contains(rec.Body.String(), "[DONE]")) {
			t.Fatal(err, peak)
		}
	}
}

func TestNoImplicitConcurrencyCeilingAndExplicitKeyLimits(t *testing.T) {
	g, _, _ := fixture(t, jsonUp)
	s := g.current.Load()
	if s.cfg.Limits.Concurrent != 0 || g.transport.MaxConnsPerHost != 0 {
		t.Fatal("implicit capacity ceiling")
	}
	k := s.byID["consumer"]
	for i := 0; i < 80; i++ {
		f := &flight{keyID: k.ID, cancel: func() {}}
		if !g.acquire(k, s, f) {
			t.Fatalf("unlimited key stopped at %d", i)
		}
		defer g.release(f)
	}
	other := *k
	other.ID = "limited"
	other.Concurrent = 1
	f := &flight{keyID: other.ID, cancel: func() {}}
	if !g.acquire(&other, s, f) || g.acquire(&other, s, &flight{}) {
		t.Fatal("single-key cap not independent")
	}
	g.release(f)
	if !g.acquire(&other, s, f) {
		t.Fatal("concurrency slot leaked")
	}
	g.release(f)
	c := s.cfg
	c.Limits.Concurrent = 12000
	c.Keys[0].Concurrent = 9000
	if _, err := compile(c); err != nil {
		t.Fatal(err)
	}
}

func TestUpstreamWaitDoesNotConsumeClientWriteDeadline(t *testing.T) {
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(1100 * time.Millisecond); jsonUp(w, r) })
	if g.transport.ResponseHeaderTimeout != 0 {
		t.Fatal("fixed upstream header deadline")
	}
	c := g.current.Load().cfg
	c.Version++
	c.Limits.WriteSeconds = 1
	n, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(n); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`); code != 200 {
		t.Fatal(code)
	}
}

func TestRequestWindowsAtomicIndependentReloadAndExpiry(t *testing.T) {
	g, _, _ := fixture(t, jsonUp)
	k := *g.current.Load().byID["consumer"]
	k.RequestLimit = 7
	k.RequestWindowSeconds = 60
	now := time.Now()
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if g.takeRequest(&k, now) == 0 {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 7 {
		t.Fatal(accepted.Load())
	}
	other := k
	other.ID = "other"
	if g.takeRequest(&other, now) != 0 {
		t.Fatal("shared key counter")
	}
	c := g.current.Load().cfg
	c.Version++
	s, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(s); err != nil {
		t.Fatal(err)
	}
	if retry := g.takeRequest(&k, now.Add(time.Millisecond)); retry != 60 {
		t.Fatal("reload reset window or bad Retry-After", retry)
	}
	if g.takeRequest(&k, now.Add(time.Minute)) != 0 {
		t.Fatal("window did not expire")
	}
	k.RequestLimit = 0
	if g.takeRequest(&k, now) != 0 {
		t.Fatal("disabled limiter rejected")
	}
}

func TestKeyRequestLimitHTTPOnlyValidModelCallsSpendQuota(t *testing.T) {
	var dispatched atomic.Int32
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { dispatched.Add(1); jsonUp(w, r) })
	c := g.current.Load().cfg
	c.Version++
	c.Keys[0].RequestLimit = 1
	c.Keys[0].RequestWindowSeconds = 60
	sum := sha256.Sum256([]byte("another-key"))
	other := c.Keys[0]
	other.ID = "other"
	other.Digest = hex.EncodeToString(sum[:])
	c.Keys = append(c.Keys, other)
	n, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(n); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/healthz", "/v1/models", "/v1/models/chat-alias"} {
		if code, _ := call(t, s, path, ""); code != 200 {
			t.Fatal(path, code)
		}
	}
	if code, _ := call(t, s, "/v1/chat/completions", `{"model":"missing"}`); code != 404 {
		t.Fatal(code)
	}
	before := dispatched.Load()
	if code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`); code != 200 {
		t.Fatal(code)
	}
	req, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"model":"chat-alias"}`))
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := s.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 429 || res.Header.Get("Retry-After") == "" || dispatched.Load() != before+1 {
		t.Fatal("over-limit reached upstream", res.StatusCode, dispatched.Load())
	}
	req, _ = http.NewRequestWithContext(context.Background(), "POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"model":"chat-alias"}`))
	req.Header.Set("Authorization", "Bearer another-key")
	res, err = s.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal("other key blocked", res.StatusCode)
	}
}
