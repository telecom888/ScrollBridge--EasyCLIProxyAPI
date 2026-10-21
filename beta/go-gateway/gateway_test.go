package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "sb_test_only_not_a_production_key_1234567890"

func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	os.Exit(m.Run())
}
func fixtureConfig(up string) Config {
	sum := sha256.Sum256([]byte(testToken))
	return Config{Version: 1, Keys: []Key{{ID: "consumer", Digest: hex.EncodeToString(sum[:]), Enabled: true, Mode: "all"}}, Models: []Model{{ID: "chat", Actual: "real-model", Aliases: []string{"chat-alias", "second-alias"}, KeepOriginal: true, Enabled: true}}, Upstreams: []Upstream{{ID: "local", URL: up}}}
}
func fixture(t *testing.T, h http.HandlerFunc) (*gateway, *httptest.Server, *ledger) {
	t.Helper()
	up := httptest.NewServer(h)
	t.Cleanup(up.Close)
	s, e := compile(fixtureConfig(up.URL))
	if e != nil {
		t.Fatal(e)
	}
	l, e := openLedger(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { l.Close() })
	g := newGateway(s, l)
	t.Cleanup(g.transport.CloseIdleConnections)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	return g, server, l
}
func call(t *testing.T, server *httptest.Server, path, body string) (int, []byte) {
	t.Helper()
	method := "POST"
	if body == "" {
		method = "GET"
	}
	r, _ := http.NewRequest(method, server.URL+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	resp, e := server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(resp.Body)
	if e != nil {
		t.Fatal(e)
	}
	return resp.StatusCode, b
}
func jsonUp(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, `{"model":"real-model","usage":{"completion_tokens":3},"choices":[]}`)
}

func TestProtocolsAliasesAndHeaders(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1beta/models/chat-alias:generateContent"} {
		t.Run(path, func(t *testing.T) {
			t.Setenv("BETA_TEST_SUPPLY", "upstream-test-key")
			g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(b), `"real-model"`) {
					t.Error(string(b))
				}
				if strings.Contains(r.URL.RawQuery, "consumer") || r.Header.Get("Cookie") != "" || r.Header.Get("X-Forwarded-For") != "" {
					t.Error("credential or forwarding leak")
				}
				if strings.HasPrefix(path, "/v1beta/") {
					if r.Header.Get("X-Goog-API-Key") != "upstream-test-key" || !strings.Contains(r.URL.Path, "real-model:") {
						t.Error("Google mapping")
					}
				} else if path == "/v1/messages" {
					if r.Header.Get("X-API-Key") != "upstream-test-key" {
						t.Error("Anthropic auth")
					}
				} else if r.Header.Get("Authorization") != "Bearer upstream-test-key" {
					t.Error("OpenAI auth")
				}
				w.Header().Set("Set-Cookie", "private=secret")
				jsonUp(w, r)
			})
			c := g.current.Load().cfg
			c.Version++
			c.Upstreams[0].KeyEnv = "BETA_TEST_SUPPLY"
			next, e := compile(c)
			if e != nil {
				t.Fatal(e)
			}
			g.apply(next)
			req, _ := http.NewRequest("POST", s.URL+path+"?key=consumer&alt=sse", strings.NewReader(`{"model":"chat-alias","messages":[{"content":"real-model"}]}`))
			req.Header.Set("Authorization", "Bearer "+testToken)
			req.Header.Set("Cookie", "secret=consumer")
			req.Header.Set("X-Forwarded-For", "1.2.3.4")
			req.Header.Set("Content-Type", "application/json")
			resp, e := s.Client().Do(req)
			if e != nil {
				t.Fatal(e)
			}
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != 200 || !bytes.Contains(b, []byte(`"model":"chat-alias"`)) || resp.Header.Get("Set-Cookie") != "" {
				t.Fatalf("%d %s", resp.StatusCode, b)
			}
		})
	}
}
func TestPolicyCannotBeEscaped(t *testing.T) {
	g, s, _ := fixture(t, jsonUp)
	cases := []struct {
		path, body string
		code       int
	}{
		{"/v1/chat/completions", `{"model":"unknown"}`, 404}, {"/v1/chat/completions", `{"model":"chat-alias","model":"real-model"}`, 400}, {"/v1/chat/completions", `{"model":"chat-alias","\u006dodel":"real-model"}`, 400}, {"/v1/chat/completions", `{"model":"chat-alias","response":{"model":"other"}}`, 400}, {"/v1/chat/completions", `{"messages":[]}`, 400}, {"/v1beta/models/chat-alias:generateContent", `{"model":"second-alias"}`, 400}, {"/admin/metrics", "", 404}, {"/v1/images/edits", `{"model":"chat-alias"}`, 404}, {"/v1%2fchat/completions", `{"model":"chat-alias"}`, 404}}
	for _, v := range cases {
		code, _ := call(t, s, v.path, v.body)
		if code != v.code {
			t.Errorf("%s %s got %d want %d", v.path, v.body, code, v.code)
		}
	}
	c := g.current.Load().cfg
	c.Version++
	c.Keys[0].Mode = "selected"
	c.Keys[0].Allowed = []string{"chat-alias"}
	c.Models[0].Enabled = false
	n, _ := compile(c)
	g.apply(n)
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	if code != 403 {
		t.Fatal(code)
	}
	code, b := call(t, s, "/v1/models", "")
	if code != 200 || !bytes.Contains(b, []byte(`"data":[]`)) {
		t.Fatalf("%d %s", code, b)
	}
}
func TestModelListAndRawID(t *testing.T) {
	g, s, _ := fixture(t, jsonUp)
	_, b := call(t, s, "/v1/models", "")
	if !bytes.Contains(b, []byte("real-model")) || !bytes.Contains(b, []byte("second-alias")) {
		t.Fatal(string(b))
	}
	c := g.current.Load().cfg
	c.Version++
	c.Models[0].KeepOriginal = false
	n, _ := compile(c)
	g.apply(n)
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"real-model"}`)
	if code != 404 {
		t.Fatal(code)
	}
	_, b = call(t, s, "/v1beta/models", "")
	if !bytes.Contains(b, []byte("models/chat-alias")) {
		t.Fatal(string(b))
	}
}
func TestUnauthorizedAndUnsupportedBodies(t *testing.T) {
	_, s, _ := fixture(t, jsonUp)
	r, _ := http.NewRequest("GET", s.URL+"/healthz", nil)
	resp, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal(resp.StatusCode)
	}
	for _, encoding := range []string{"gzip", ""} {
		r, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader("x"))
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.Header.Set("Content-Encoding", encoding)
		r.Header.Set("Content-Type", "multipart/form-data")
		resp, e = s.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 415 {
			t.Fatal(resp.StatusCode)
		}
	}
}
func TestSSEIsIncrementalAndCancellationPropagates(t *testing.T) {
	cancelled := make(chan struct{})
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"model\":\"real-model\",\"choices\":[]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	})
	req, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"model":"chat-alias","stream":true}`))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "application/json")
	resp, e := s.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	line, e := bufio.NewReader(resp.Body).ReadString('\n')
	if e != nil || !strings.Contains(line, "chat-alias") {
		t.Fatalf("%q %v", line, e)
	}
	resp.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream not cancelled")
	}
	waitIdle(t, g)
}
func waitIdle(t *testing.T, g *gateway) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		m := g.metrics()
		if m["active"] == 0 && m["buffer_reserved_bytes"] == int64(0) {
			return
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatal(g.metrics())
}
func TestHotRevocationCancelsOpenStream(t *testing.T) {
	cancelled := make(chan struct{})
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, ": connected\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	})
	r, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"model":"chat-alias","stream":true}`))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	resp, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	c := g.current.Load().cfg
	b, _ := json.Marshal(c)
	var cloned Config
	json.Unmarshal(b, &cloned)
	cloned.Version++
	cloned.Keys[0].Enabled = false
	n, _ := compile(cloned)
	if e = g.apply(n); e != nil {
		t.Fatal(e)
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("revoked stream still active")
	}
	code, _ := call(t, s, "/v1/models", "")
	if code != 401 {
		t.Fatal(code)
	}
	waitIdle(t, g)
}
func TestResourceLimits(t *testing.T) {
	for _, kind := range []string{"body", "event", "response", "output", "memory"} {
		t.Run(kind, func(t *testing.T) {
			g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				if kind == "event" || kind == "output" {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprintf(w, "data: %s\n\n", strings.Repeat("x", 300))
				} else {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprintf(w, `{"text":"%s"}`, strings.Repeat("x", 500))
				}
			})
			c := g.current.Load().cfg
			c.Version++
			switch kind {
			case "body":
				c.Limits.BodyBytes = 128
			case "event":
				c.Limits.EventBytes = 128
			case "output":
				c.Limits.OutputBytes = 128
			case "response":
				c.Limits.ResponseBytes = 128
			case "memory":
				c.Limits.BodyBytes = 1024
				c.Limits.MemoryBytes = 1024
			}
			n, e := compile(c)
			if e != nil {
				t.Fatal(e)
			}
			g.apply(n)
			body := `{"model":"chat-alias","prompt":"` + strings.Repeat("x", 180) + `"}`
			req, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+testToken)
			req.Header.Set("Content-Type", "application/json")
			resp, e := s.Client().Do(req)
			if e != nil {
				t.Fatal(e)
			}
			b, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if kind == "event" || kind == "output" {
				if readErr == nil {
					t.Fatalf("unbounded stream: %s", b)
				}
			} else if resp.StatusCode < 400 {
				t.Fatal(resp.StatusCode)
			}
			waitIdle(t, g)
		})
	}
}
func TestConcurrencyLimitRejectsBeforeSupply(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var count atomic.Int32
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if count.Add(1) == 1 {
			close(entered)
		}
		<-release
		jsonUp(w, r)
	})
	c := g.current.Load().cfg
	c.Version++
	c.Limits.Concurrent = 1
	n, _ := compile(c)
	g.apply(n)
	done := make(chan struct{})
	go func() { call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`); close(done) }()
	<-entered
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	close(release)
	<-done
	if code != 429 || count.Load() != 1 {
		t.Fatalf("%d %d", code, count.Load())
	}
}
func TestNoAutomaticGenerationRetryAndCooldown(t *testing.T) {
	var count atomic.Int32
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		w.Header().Set("Retry-After", "2")
		problem(w, 429, "slow down")
	})
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	if code != 429 {
		t.Fatal(code)
	}
	code, _ = call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	if code != 503 || count.Load() != 1 {
		t.Fatalf("%d %d", code, count.Load())
	}
	g.pool.mu.Lock()
	g.pool.states["local"].until = time.Now().Add(-time.Second)
	g.pool.mu.Unlock()
	code, _ = call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	if code != 429 || count.Load() != 2 {
		t.Fatal(code, count.Load())
	}
}
func TestOutputQuotaReserveReconcileAndRestart(t *testing.T) {
	g, s, l := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if !bytes.Contains(b, []byte(`"max_completion_tokens":10`)) {
			t.Errorf("not capped: %s", b)
		}
		jsonUp(w, r)
	})
	c := g.current.Load().cfg
	c.Version++
	c.Keys[0].OutputTokens = 15
	c.Keys[0].MaxOutputTokens = 10
	n, _ := compile(c)
	g.apply(n)
	for i := 0; i < 2; i++ {
		code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias","max_tokens":100}`)
		if code != 200 {
			t.Fatal(code)
		}
	}
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	if code != 429 {
		t.Fatal(code)
	}
	l.mu.Lock()
	used := l.used["consumer"]
	l.mu.Unlock()
	if used != 6 {
		t.Fatal(used)
	}
}
func TestMissingOrTruncatedUsageChargesReservation(t *testing.T) {
	for _, body := range []string{`{"model":"real-model"}`, "data: {\"usage\":{\"output_tokens\":1}}\n\n"} {
		t.Run(body, func(t *testing.T) {
			g, s, l := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				ct := "application/json"
				if strings.HasPrefix(body, "data:") {
					ct = "text/event-stream"
				}
				w.Header().Set("Content-Type", ct)
				fmt.Fprint(w, body)
			})
			c := g.current.Load().cfg
			c.Version++
			c.Keys[0].OutputTokens = 10
			c.Keys[0].MaxOutputTokens = 10
			n, _ := compile(c)
			g.apply(n)
			call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
			code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
			if code != 429 {
				t.Fatal(code)
			}
			l.mu.Lock()
			used := l.used["consumer"]
			l.mu.Unlock()
			if used != 10 {
				t.Fatal(used)
			}
		})
	}
}
func TestLedgerCrashRecoveryLockAndConcurrentReservations(t *testing.T) {
	dir := t.TempDir()
	l, e := openLedger(dir)
	if e != nil {
		t.Fatal(e)
	}
	if other, e := openLedger(dir); e == nil {
		other.Close()
		t.Fatal("two writers admitted")
	}
	var wg sync.WaitGroup
	var accepted atomic.Int32
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.Reserve("key", 10, 100) == nil {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 10 {
		t.Fatal(accepted.Load())
	}
	l.Close()
	l, e = openLedger(dir)
	if e != nil {
		t.Fatal(e)
	}
	if l.Reserve("key", 1, 100) == nil {
		t.Fatal("restart reset quota")
	}
	l.Refund("key", 10)
	l.Close()
	f, _ := os.OpenFile(filepath.Join(dir, "quota.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString("torn")
	f.Close()
	if l, e = openLedger(dir); e == nil {
		l.Close()
		t.Fatal("torn journal accepted")
	}
}
func TestStrictJSONAndConfigValidation(t *testing.T) {
	for _, b := range []string{`{"model":"x","\u006dodel":"y"}`, `{} {}`, `{"x":[1,]}`, strings.Repeat("[", 66) + "0" + strings.Repeat("]", 66)} {
		if _, e := strictJSON([]byte(b)); e == nil {
			t.Error(b)
		}
	}
	for _, mutate := range []func(*Config){func(c *Config) { c.Listen = "0.0.0.0:18453" }, func(c *Config) { c.Upstreams[0].URL = "http://example.com" }, func(c *Config) { c.Models[0].Aliases = []string{"real-model"} }, func(c *Config) { c.Keys[0].Mode = "other" }, func(c *Config) { c.Keys[0].Allowed = []string{"unknown"} }, func(c *Config) { c.Limits.Concurrent = -1 }} {
		c := fixtureConfig("http://127.0.0.1:1")
		mutate(&c)
		if _, e := compile(c); e == nil {
			t.Error("bad configuration accepted")
		}
	}
}
func TestSnapshotVersionAndStaleness(t *testing.T) {
	g, s, _ := fixture(t, jsonUp)
	if g.apply(g.current.Load()) == nil {
		t.Fatal("rollback accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watch(ctx, g, func(context.Context) (*snapshot, error) { return nil, fmt.Errorf("offline") }, nil)
	deadline := time.Now().Add(8 * time.Second)
	for !g.stale.Load() && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
	}
	if !g.stale.Load() {
		t.Fatal("source outage not enforced")
	}
	code, _ := call(t, s, "/v1/models", "")
	if code != 503 {
		t.Fatal(code)
	}
}
