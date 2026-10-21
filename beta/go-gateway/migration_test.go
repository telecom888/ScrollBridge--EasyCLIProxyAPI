package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"github.com/gorilla/websocket"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWebSocketUsageQuotaAliasAndRevocation(t *testing.T) {
	upgraded := make(chan struct{}, 1)
	g, s, l := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{}
		c, e := up.Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer c.Close()
		upgraded <- struct{}{}
		for {
			_, b, e := c.ReadMessage()
			if e != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(b, &m) != nil {
				return
			}
			if m["model"] != "real-model" || m["max_output_tokens"] != float64(10) {
				t.Errorf("wrong request %s", b)
			}
			c.WriteJSON(map[string]any{"type": "response.created", "response": map[string]any{"id": "r1", "model": "real-model"}})
			c.WriteJSON(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r1", "model": "real-model", "usage": map[string]any{"input_tokens": 1000, "input_tokens_details": map[string]any{"cached_tokens": 200}, "output_tokens": 3}}})
		}
	})
	raw, _ := json.Marshal(g.current.Load().cfg)
	var cfg Config
	json.Unmarshal(raw, &cfg)
	cfg.Version++
	cfg.Keys[0].OutputTokens = 20
	cfg.Keys[0].MaxOutputTokens = 10
	cfg.Billing = Billing{Enabled: true, Currency: "USD", Rates: Rates{"2", "8", "0.5"}}
	next, e := compile(cfg)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(next)
	var mu sync.Mutex
	records := []map[string]any{}
	g.record = func(v map[string]any) { mu.Lock(); records = append(records, v); mu.Unlock() }
	c, _, e := websocket.DefaultDialer.Dial(strings.Replace(s.URL, "http:", "ws:", 1)+"/v1/responses", http.Header{"Authorization": []string{"Bearer " + testToken}})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	<-upgraded
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	c.WriteJSON(map[string]any{"type": "response.create", "model": "chat-alias"})
	for i := 0; i < 2; i++ {
		var event map[string]any
		if e = c.ReadJSON(&event); e != nil {
			t.Fatal(e)
		}
		if event["response"].(map[string]any)["model"] != "chat-alias" {
			t.Fatal(event)
		}
	}
	l.mu.Lock()
	used := l.used["consumer"]
	l.mu.Unlock()
	if used != 3 {
		t.Fatal(used)
	}
	raw, _ = json.Marshal(cfg)
	json.Unmarshal(raw, &cfg)
	cfg.Version++
	cfg.Keys[0].Enabled = false
	next, _ = compile(cfg)
	g.apply(next)
	_, _, e = c.ReadMessage()
	if !websocket.IsCloseError(e, 1008) {
		t.Fatal(e)
	}
	waitIdle(t, g)
	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, record := range records {
		if b, ok := record["billing"].(map[string]any); ok && b["amount"] == "0.001724000" {
			found = true
		}
	}
	if !found {
		t.Fatal(records)
	}
}
func TestImageConversionMultipartAndCompression(t *testing.T) {
	var seen map[string]any
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "gemini-3.1-flash-image:generateContent") {
			t.Error(r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&seen)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		io.WriteString(gz, `{"candidates":[{"content":{"parts":[{"thought":true,"inlineData":{"mimeType":"image/png","data":"Yg=="}},{"inline_data":{"mime_type":"image/webp","data":"aW1hZ2U="}}]}}]}`)
		gz.Close()
	})
	cfg := g.current.Load().cfg
	cfg.Version++
	cfg.Images = true
	cfg.GeminiImages = true
	cfg.Models[0].Actual = "gemini-3.1-flash-image"
	next, e := compile(cfg)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(next)
	data, ct, e := encodeMultipart(map[string]any{"model": "chat-alias", "prompt": "edit", "n": "1"}, []upload{{Name: "image", Filename: "reference.png", Mime: "image/png", Data: []byte{0, 255, 128, 13, 10}}})
	if e != nil {
		t.Fatal(e)
	}
	r, _ := http.NewRequest("POST", s.URL+"/v1/images/edits", bytes.NewReader(data))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", ct)
	res, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Contains(b, []byte(`"output_format":"webp"`)) {
		t.Fatal(res.StatusCode, string(b))
	}
	if seen["contents"] == nil {
		t.Fatal(seen)
	}
	for _, bad := range []string{`{"model":"chat-alias","prompt":"edit","image":"http://127.0.0.1/private"}`, `{"model":"chat-alias","prompt":"edit","mask":"unsupported"}`} {
		code, _ := call(t, s, "/v1/images/edits", bad)
		if code != 400 {
			t.Fatal(code)
		}
	}
}

func TestNamespacedActualModelWithStableExposureID(t *testing.T) {
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "vendor/model:latest" {
			t.Error(body)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"model":"vendor/model:latest","choices":[]}`)
	})
	c := g.current.Load().cfg
	c.Version++
	c.Models[0].Actual = "vendor/model:latest"
	c.Models[0].ExposureIDs = map[string]string{"vendor/model:latest": "original-model"}
	n, e := compile(c)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(n)
	code, b := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	if code != 200 || !bytes.Contains(b, []byte(`"model":"chat-alias"`)) {
		t.Fatal(code, string(b))
	}
}

func TestPriceOnlyReloadPreservesOpenStream(t *testing.T) {
	release := make(chan struct{})
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
			io.WriteString(w, "data: [DONE]\n\n")
		case <-r.Context().Done():
		}
	})
	r, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"model":"chat-alias","stream":true}`))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	res, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	first := make([]byte, 4096)
	if _, e = res.Body.Read(first); e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(g.current.Load().cfg)
	var c Config
	json.Unmarshal(b, &c)
	c.Version++
	c.Billing = Billing{Enabled: true, Currency: "USD", Rates: Rates{"2", "8", "0.5"}}
	n, e := compile(c)
	if e != nil {
		t.Fatal(e)
	}
	if e = g.apply(n); e != nil {
		t.Fatal(e)
	}
	close(release)
	tail, e := io.ReadAll(res.Body)
	if e != nil || !bytes.Contains(tail, []byte("[DONE]")) {
		t.Fatal(string(tail), e)
	}
	waitIdle(t, g)
}

func TestDeniedModelIsStillNamedInDesktopRecord(t *testing.T) {
	g, s, _ := fixture(t, jsonUp)
	records := make(chan map[string]any, 1)
	g.record = func(m map[string]any) { records <- m }
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"unavailable-model"}`)
	if code != 404 {
		t.Fatal(code)
	}
	record := <-records
	if record["model"] != "unavailable-model" || record["status"] != 404 {
		t.Fatal(record)
	}
}

func TestOversizedModelCannotFloodDesktopControlPipe(t *testing.T) {
	g, s, _ := fixture(t, func(http.ResponseWriter, *http.Request) { t.Error("invalid model forwarded") })
	records := make(chan map[string]any, 1)
	g.record = func(m map[string]any) { records <- m }
	body := `{"model":"` + strings.Repeat("x", 2<<20) + `"}`
	code, _ := call(t, s, "/v1/chat/completions", body)
	if code != 400 {
		t.Fatal(code)
	}
	record := <-records
	b, _ := json.Marshal(record)
	if len(b) > 4096 {
		t.Fatal("unbounded record")
	}
}

func TestImageUsageCostAggregatesEveryGeneratedImage(t *testing.T) {
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"usage":{"input_tokens":10,"output_tokens":2,"cost":"0.25"},"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"YQ=="}}]}}]}`)
	})
	c := g.current.Load().cfg
	c.Version++
	c.Images = true
	c.GeminiImages = true
	c.Models[0].Actual = "gemini-3.1-flash-image"
	c.Billing = Billing{Enabled: true, ReadUsagePrice: true, Currency: "USD", Rates: Rates{"2", "8", "0.5"}}
	n, e := compile(c)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(n)
	records := make(chan map[string]any, 1)
	g.record = func(m map[string]any) { records <- m }
	code, _ := call(t, s, "/v1/images/generations", `{"model":"chat-alias","prompt":"test","n":2}`)
	if code != 200 {
		t.Fatal(code)
	}
	record := <-records
	bill, ok := record["billing"].(map[string]any)
	if !ok || bill["amount"] != "0.500000000" || bill["source"] != "upstream_usage" {
		t.Fatal(record)
	}
}
