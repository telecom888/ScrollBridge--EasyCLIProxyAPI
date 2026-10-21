package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type flight struct {
	cancel       context.CancelFunc
	keyID, model string
	version      int64
}
type gateway struct {
	current                    atomic.Pointer[snapshot]
	transport                  *http.Transport
	pool                       *pool
	ledger                     accounting
	audit                      *audit
	auditFailed                atomic.Bool
	mu                         sync.Mutex
	active                     map[*flight]bool
	keyActive                  map[string]int
	memory                     int64
	stale                      atomic.Bool
	requests, rejected, failed atomic.Uint64
}

func newGateway(s *snapshot, l accounting) *gateway {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.DisableCompression = true
	t.MaxIdleConns = 256
	t.MaxIdleConnsPerHost = 128
	t.MaxConnsPerHost = 4096
	t.ResponseHeaderTimeout = 30 * time.Second
	t.IdleConnTimeout = 90 * time.Second
	g := &gateway{transport: t, pool: newPool(), ledger: l, active: map[*flight]bool{}, keyActive: map[string]int{}}
	g.current.Store(s)
	return g
}
func (g *gateway) apply(s *snapshot) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	old := g.current.Load()
	if s.cfg.Version <= old.cfg.Version {
		return errors.New("configuration version must increase")
	}
	if s.cfg.Listen != old.cfg.Listen {
		return errors.New("listen address requires restart")
	}
	// Credential bindings are restart-only; rotating an environment variable is not a hot reload.
	if g.memory > s.cfg.Limits.MemoryBytes {
		return errors.New("new memory limit below current reservations")
	}
	g.current.Store(s)
	g.pool.prune(s.cfg.Upstreams)
	// Cancel every old flight: revocation must not wait for a long-lived stream.
	for f := range g.active {
		f.cancel()
	}
	return nil
}
func (g *gateway) acquire(k *Key, s *snapshot, f *flight) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.current.Load() != s || g.stale.Load() || g.auditFailed.Load() {
		return false
	}
	limit := k.Concurrent
	if limit == 0 {
		limit = s.cfg.Limits.Concurrent
	}
	if len(g.active) >= s.cfg.Limits.Concurrent || g.keyActive[k.ID] >= limit {
		return false
	}
	g.active[f] = true
	g.keyActive[k.ID]++
	return true
}
func (g *gateway) release(f *flight) {
	g.mu.Lock()
	delete(g.active, f)
	g.keyActive[f.keyID]--
	if g.keyActive[f.keyID] == 0 {
		delete(g.keyActive, f.keyID)
	}
	g.mu.Unlock()
}
func (g *gateway) mem(n int64, limit int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if n > 0 && g.memory+n > limit {
		return false
	}
	g.memory += n
	return true
}
func (g *gateway) read(src io.Reader, limit, memLimit int64) ([]byte, func(), error) {
	var charged int64
	release := func() { g.mem(-charged, memLimit); charged = 0 }
	parts := [][]byte{}
	var size int64
	for {
		buf := make([]byte, min(int64(32<<10), limit-size+1))
		n, e := src.Read(buf)
		if n > 0 {
			size += int64(n)
			if size > limit {
				release()
				return nil, func() {}, errors.New("payload limit")
			}
			cost := int64(n) * 6
			if !g.mem(cost, memLimit) {
				release()
				return nil, func() {}, errors.New("buffer budget exhausted")
			}
			charged += cost
			parts = append(parts, buf[:n])
		}
		if e != nil {
			if e != io.EOF {
				release()
				return nil, func() {}, e
			}
			break
		}
	}
	return bytes.Join(parts, nil), release, nil
}
func token(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "Bearer ") {
		return h[7:]
	}
	for _, k := range []string{"X-API-Key", "X-Goog-API-Key"} {
		if v := r.Header.Get(k); v != "" {
			return v
		}
	}
	return r.URL.Query().Get("key")
}
func problem(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": msg, "type": "gateway_error"}})
}

var posts = map[string]bool{"/v1/chat/completions": true, "/v1/completions": true, "/v1/responses": true, "/v1/responses/compact": true, "/v1/messages": true, "/v1/messages/count_tokens": true, "/v1/embeddings": true, "/v1beta/interactions": true}

func route(r *http.Request, images bool) (list bool, pathModel string, ok bool) {
	p := r.URL.Path
	if r.URL.RawPath != "" || strings.Contains(p, "..") || r.Header.Get("Upgrade") != "" {
		return false, "", false
	}
	if r.Method == "GET" {
		return p == "/v1/models" || p == "/v1beta/models", "", p == "/healthz" || p == "/v1/models" || p == "/v1beta/models"
	}
	if r.Method != "POST" {
		return false, "", false
	}
	if posts[p] || images && (p == "/v1/images/generations") {
		return false, "", true
	}
	if strings.HasPrefix(p, "/v1beta/models/") {
		s := strings.TrimPrefix(p, "/v1beta/models/")
		name, op, found := strings.Cut(s, ":")
		if found && validID.MatchString(name) && (op == "generateContent" || op == "streamGenerateContent" || op == "countTokens") {
			return false, name, true
		}
	}
	return false, "", false
}
func strip(h http.Header, request bool) {
	for _, part := range strings.Split(h.Get("Connection"), ",") {
		h.Del(strings.TrimSpace(part))
	}
	for k := range h {
		n := strings.ToLower(k)
		bad := n == "connection" || n == "keep-alive" || n == "proxy-authenticate" || n == "proxy-authorization" || n == "te" || n == "trailer" || n == "transfer-encoding" || n == "upgrade" || n == "set-cookie" || strings.HasPrefix(n, "access-control-")
		if request {
			bad = bad || n == "authorization" || n == "x-api-key" || n == "x-goog-api-key" || n == "cookie" || n == "forwarded" || n == "origin" || n == "referer" || n == "accept-encoding" || strings.HasPrefix(n, "cf-") || strings.HasPrefix(n, "x-forwarded-")
		}
		if bad {
			h.Del(k)
		}
	}
}
func outputLimit(m map[string]any, path string, k *Key) (int64, error) {
	if k.OutputTokens == 0 {
		return 0, nil
	}
	if strings.Contains(path, "images/") || strings.Contains(path, "embeddings") || strings.Contains(path, "count") || strings.Contains(path, "interactions") {
		return 0, errors.New("token quota requires a text generation endpoint")
	}
	selected := "max_tokens"
	container := m
	if strings.Contains(path, "/responses") {
		selected = "max_output_tokens"
	} else if strings.Contains(path, "/chat/") {
		selected = "max_completion_tokens"
	} else if strings.Contains(path, "/v1beta/models/") {
		selected = "maxOutputTokens"
		if x, ok := m["generationConfig"].(map[string]any); ok {
			container = x
		} else {
			container = map[string]any{}
			m["generationConfig"] = container
		}
	}
	requested := k.MaxOutputTokens
	for _, field := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens"} {
		if value, exists := container[field]; exists {
			n, ok := value.(json.Number)
			if !ok {
				return 0, errors.New("invalid output token ceiling")
			}
			i, e := n.Int64()
			if e != nil || i <= 0 {
				return 0, errors.New("invalid output token ceiling")
			}
			requested = min(requested, i)
			delete(container, field)
		}
	}
	container[selected] = requested
	if strings.Contains(path, "/chat/") {
		if stream, ok := m["stream"].(bool); ok && stream {
			opts, ok := m["stream_options"].(map[string]any)
			if !ok {
				opts = map[string]any{}
				m["stream_options"] = opts
			}
			opts["include_usage"] = true
		}
	}
	return requested, nil
}
func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Duration(g.current.Load().cfg.Limits.WriteSeconds) * time.Second))
	g.requests.Add(1)
	start := time.Now()
	s := g.current.Load()
	k := s.auth(token(r))
	if k == nil {
		g.rejected.Add(1)
		problem(w, 401, "invalid API key")
		return
	}
	list, pathModel, ok := route(r, s.cfg.Images)
	if !ok {
		g.rejected.Add(1)
		problem(w, 404, "endpoint not enabled in Go beta")
		return
	}
	if g.stale.Load() || g.auditFailed.Load() {
		g.rejected.Add(1)
		problem(w, 503, "configuration or audit storage unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Limits.RequestSeconds)*time.Second)
	defer cancel()
	f := &flight{cancel: cancel, keyID: k.ID, version: s.cfg.Version}
	if !g.acquire(k, s, f) {
		g.rejected.Add(1)
		w.Header().Set("Retry-After", "1")
		problem(w, 429, "concurrency limit or configuration changing")
		return
	}
	defer g.release(f)
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(60 * time.Second))
	status := 200
	requested := ""
	actual := ""
	upID := ""
	billing := s.cfg.Billing
	result := "complete"
	var reservation int64
	dispatched := false
	u := usage{}
	defer func() {
		if result != "complete" {
			g.failed.Add(1)
		}
		bill := calculateBill(billing, u)
		if bill != nil && requested != "" && g.audit != nil {
			id := make([]byte, 16)
			_, idErr := rand.Read(id)
			record := map[string]any{"id": fmt.Sprintf("%x", id), "time": time.Now().UTC().Format(time.RFC3339Nano), "config_version": s.cfg.Version, "key_id": k.ID, "model": requested, "actual_model": actual, "status": status, "result": result, "billing": bill}
			if idErr != nil || g.audit.append(record) != nil {
				g.auditFailed.Store(true)
				slog.Error("billing audit unavailable; traffic blocked")
			}
		}
		slog.Info("request", "key_id", k.ID, "model", requested, "actual_model", actual, "upstream", upID, "method", r.Method, "path", r.URL.Path, "status", status, "result", result, "ms", time.Since(start).Milliseconds(), "output_tokens", u.Tokens, "usage_found", u.Found, "billing", bill)
	}()
	reject := func(code int, msg string) { status = code; g.rejected.Add(1); problem(w, code, msg) }
	if r.URL.Path == "/healthz" {
		if g.stale.Load() {
			reject(503, "configuration source stale")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": s.cfg.Version})
		return
	}
	if list {
		names := []string{}
		for _, e := range s.names {
			if _, code := s.resolve(k, e.Name); code == 0 {
				names = append(names, e.Name)
			}
		}
		sort.Strings(names)
		items := []any{}
		google := strings.HasPrefix(r.URL.Path, "/v1beta/")
		for _, n := range names {
			if google {
				items = append(items, map[string]any{"name": "models/" + n, "supportedGenerationMethods": []string{"generateContent", "streamGenerateContent", "countTokens"}})
			} else {
				items = append(items, map[string]any{"id": n, "object": "model", "owned_by": "scrollbridge"})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if google {
			json.NewEncoder(w).Encode(map[string]any{"models": items})
		} else {
			json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": items})
		}
		return
	}
	if r.Header.Get("Content-Encoding") != "" && r.Header.Get("Content-Encoding") != "identity" {
		reject(415, "compressed requests are not supported in this beta")
		return
	}
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mt != "application/json" {
		reject(415, "JSON request required")
		return
	}
	raw, free, err := g.read(r.Body, s.cfg.Limits.BodyBytes, s.cfg.Limits.MemoryBytes)
	if err != nil {
		reject(413, "request body or shared buffer limit")
		return
	}
	defer free()
	value, err := strictJSON(raw)
	m, object := value.(map[string]any)
	if err != nil || !object {
		reject(400, "invalid or ambiguous JSON")
		return
	}
	bodyModel, _ := m["model"].(string)
	requested = bodyModel
	if pathModel != "" {
		requested = pathModel
		if bodyModel != "" && normalized(bodyModel) != normalized(pathModel) {
			reject(400, "conflicting models")
			return
		}
	}
	if requested == "" {
		reject(400, "model is required")
		return
	}
	e, code := s.resolve(k, requested)
	if code != 0 {
		reject(code, "model unavailable for this key")
		return
	}
	actual = e.Actual
	billing = e.Billing
	f.model = requested
	if nested, ok := m["response"].(map[string]any); ok {
		if n, exists := nested["model"]; exists {
			if n != requested {
				reject(400, "conflicting nested model")
				return
			}
			nested["model"] = actual
		}
	}
	if bodyModel != "" {
		m["model"] = actual
	}
	reservation, err = outputLimit(m, r.URL.Path, k)
	if err != nil {
		reject(400, err.Error())
		return
	}
	// Admission and reservation happen before any supply request. No generation retries.
	if reservation > 0 {
		if err = g.ledger.Reserve(k.ID, reservation, k.OutputTokens); err != nil {
			reject(429, "quota unavailable or exhausted")
			return
		}
		defer func() {
			refund := int64(0)
			if !dispatched {
				refund = reservation
			} else if result == "complete" && status < 400 && u.Found && u.Complete && u.Tokens <= reservation {
				refund = reservation - u.Tokens
			}
			if refund > 0 {
				if err := g.ledger.Refund(k.ID, refund); err != nil {
					slog.Error("quota refund failed", "key_id", k.ID)
					result = "quota_refund_failed"
				}
			}
		}()
	}
	body, err := json.Marshal(m)
	if err != nil {
		reject(400, "cannot encode request")
		return
	}
	supply, done, available := g.pool.pick(s.cfg.Upstreams)
	if !available {
		result = "supply_unavailable"
		reject(503, "all upstreams cooling down")
		return
	}
	upID = supply.ID
	target, _ := url.Parse(supply.URL)
	target.Path = r.URL.Path
	if pathModel != "" {
		target.Path = strings.Replace(target.Path, "/models/"+pathModel+":", "/models/"+actual+":", 1)
	}
	q := r.URL.Query()
	for _, n := range []string{"key", "api_key", "access_token"} {
		q.Del(n)
	}
	target.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		done(0, nil, err)
		result = "request_failed"
		reject(502, "cannot create upstream request")
		return
	}
	req.Header = r.Header.Clone()
	strip(req.Header, true)
	req.Header.Del("Content-Length")
	req.Header.Set("Accept-Encoding", "identity")
	if secret := os.Getenv(supply.KeyEnv); secret != "" {
		if strings.HasPrefix(target.Path, "/v1beta/") {
			req.Header.Set("X-Goog-API-Key", secret)
		} else if strings.HasPrefix(target.Path, "/v1/messages") {
			req.Header.Set("X-API-Key", secret)
		} else {
			req.Header.Set("Authorization", "Bearer "+secret)
		}
	}
	if ctx.Err() != nil {
		done(499, nil, nil)
		result = "cancelled_before_dispatch"
		reject(503, "configuration changed or request cancelled")
		return
	}
	dispatched = true
	response, err := g.transport.RoundTrip(req)
	if err != nil {
		if ctx.Err() != nil {
			done(499, nil, nil)
		} else {
			done(0, nil, err)
		}
		result = "upstream_failed"
		reject(502, "upstream unavailable")
		return
	}
	defer response.Body.Close()
	status = response.StatusCode
	// Classify header errors immediately. Successful streams stay active until completed.
	doneCalled := false
	if status == 429 || status >= 500 {
		done(status, response.Header, nil)
		doneCalled = true
	}
	defer func() {
		if !doneCalled {
			var e error
			if result != "complete" && ctx.Err() == nil {
				e = errors.New("upstream response failed")
			}
			if ctx.Err() != nil {
				done(499, nil, nil)
			} else {
				done(status, response.Header, e)
			}
		}
	}()
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		result = "unsupported_encoding"
		reject(502, "upstream ignored identity encoding")
		return
	}
	headers := response.Header.Clone()
	strip(headers, false)
	for _, n := range []string{"Content-Length", "Content-Encoding", "ETag", "Content-MD5", "Digest"} {
		headers.Del(n)
	}
	headers.Set("Cache-Control", "no-store")
	ct, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	dst := &deadlineWriter{w: w, seconds: s.cfg.Limits.WriteSeconds, limit: s.cfg.Limits.OutputBytes}
	if ct == "text/event-stream" && status < 400 {
		// Reserve a bounded event plus parsing/encoding workspace, independently of body buffers.
		eventMemory := int64(s.cfg.Limits.EventBytes)*8 + 32<<10
		if !g.mem(eventMemory, s.cfg.Limits.MemoryBytes) {
			result = "buffer_limit"
			reject(503, "shared stream buffer limit")
			return
		}
		defer g.mem(-eventMemory, s.cfg.Limits.MemoryBytes)
		for n, v := range headers {
			w.Header()[n] = v
		}
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(status)
		_ = http.NewResponseController(w).Flush()
		err = streamSSE(dst, response.Body, e, s.cfg.Limits.EventBytes, &u, reservation)
		if err != nil {
			result = "stream_interrupted"
			cancel()
			panic(http.ErrAbortHandler)
		}
		return
	}
	// Buffered JSON is bounded across all requests; oversized payloads fail before headers commit.
	b, release, err := g.read(response.Body, s.cfg.Limits.ResponseBytes, s.cfg.Limits.MemoryBytes)
	if err != nil {
		result = "response_limit"
		reject(502, "upstream response or shared buffer limit")
		return
	}
	defer release()
	if ct == "application/json" {
		v, err := strictJSON(b)
		if err != nil {
			result = "invalid_response"
			reject(502, "invalid upstream JSON")
			return
		}
		observe(v, &u)
		if billing.Enabled {
			observeCost(v, &u, billing.UsageCostPointer)
		}
		u.Complete = true
		rewrite(v, actual, requested)
		b, _ = json.Marshal(v)
	}
	if int64(len(b)) > s.cfg.Limits.OutputBytes {
		result = "output_limit"
		reject(502, "output byte limit")
		return
	}
	for n, v := range headers {
		w.Header()[n] = v
	}
	w.WriteHeader(status)
	if _, err = dst.Write(b); err != nil {
		result = "client_write_failed"
		cancel()
	}
}
func (g *gateway) metrics() map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return map[string]any{"requests": g.requests.Load(), "rejected": g.rejected.Load(), "failed": g.failed.Load(), "active": len(g.active), "buffer_reserved_bytes": g.memory, "version": g.current.Load().cfg.Version, "stale": g.stale.Load(), "audit_failed": g.auditFailed.Load()}
}
func serverFor(g *gateway) *http.Server {
	return &http.Server{Addr: g.current.Load().cfg.Listen, Handler: g, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
}
