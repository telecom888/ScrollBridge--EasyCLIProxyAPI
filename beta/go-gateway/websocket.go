package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type wsTurn struct {
	entry         entry
	requested, id string
	reserved      int64
	began         time.Time
	settled       bool
	flight        *flight
}

func (g *gateway) serveWebSocket(w http.ResponseWriter, r *http.Request, s *snapshot, k *Key) {
	if r.Method != "GET" || r.URL.Path != "/v1/responses" || r.URL.RawPath != "" {
		problem(w, 404, "WebSocket route not found")
		return
	}
	if g.stale.Load() || g.auditFailed.Load() {
		problem(w, 503, "gateway unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Limits.RequestSeconds)*time.Second)
	defer cancel()
	f := &flight{cancel: cancel, keyID: k.ID, version: s.cfg.Version, session: true}
	if !g.acquire(k, s, f) {
		problem(w, 429, "connection limit")
		return
	}
	defer g.release(f)
	current := r.URL.Query().Get("model")
	var selected entry
	if current != "" {
		var code int
		selected, code = s.resolve(k, current)
		if code == 0 && !s.cfg.Speech && speechRequest(r.URL.Path, selected.Actual, nil) {
			code = 404
		}
		if code != 0 {
			problem(w, code, "model unavailable")
			return
		}
	}
	supply, finish, ok := g.pool.pick(s.cfg.Upstreams)
	if !ok {
		problem(w, 503, "all upstreams cooling down")
		return
	}
	defer finish(499, nil, nil)
	target, _ := url.Parse(supply.URL)
	target.Path = "/v1/responses"
	if target.Scheme == "https" {
		target.Scheme = "wss"
	} else {
		target.Scheme = "ws"
	}
	q := r.URL.Query()
	for _, name := range []string{"key", "api_key", "access_token"} {
		q.Del(name)
	}
	if current != "" {
		q.Set("model", selected.Actual)
	}
	target.RawQuery = q.Encode()
	headers := r.Header.Clone()
	strip(headers, true)
	for name := range headers {
		if strings.HasPrefix(strings.ToLower(name), "sec-websocket-") {
			headers.Del(name)
		}
	}
	if key := os.Getenv(supply.KeyEnv); key != "" {
		headers.Set("Authorization", "Bearer "+key)
	}
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 4096, EnableCompression: false}
	remote, response, err := dialer.DialContext(ctx, target.String(), headers)
	if err != nil {
		status := 502
		if response != nil {
			status = response.StatusCode
			response.Body.Close()
		}
		finish(status, nil, err)
		problem(w, status, "WebSocket upstream unavailable")
		return
	}
	defer remote.Close()
	remote.SetReadLimit(s.cfg.Limits.BodyBytes)
	upgrade := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, EnableCompression: false, CheckOrigin: func(*http.Request) bool { return true }}
	local, err := upgrade.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer local.Close()
	local.SetReadLimit(s.cfg.Limits.BodyBytes)
	closed := make(chan struct{})
	var writeLocal sync.Mutex
	send := func(kind int, b []byte) error {
		writeLocal.Lock()
		defer writeLocal.Unlock()
		local.SetWriteDeadline(time.Now().Add(time.Duration(s.cfg.Limits.WriteSeconds) * time.Second))
		return local.WriteMessage(kind, b)
	}
	sendError := func(status int, msg string) {
		b, _ := json.Marshal(map[string]any{"type": "error", "status": status, "error": map[string]any{"type": "invalid_request_error", "message": msg}})
		if send(websocket.TextMessage, b) != nil {
			cancel()
		}
	}
	go func() {
		select {
		case <-ctx.Done():
			_ = local.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "Configuration changed or connection closed"), time.Now().Add(time.Second))
			local.Close()
			remote.Close()
		case <-closed:
		}
	}()
	defer close(closed)
	var mu sync.Mutex
	pending := []*wsTurn{}
	turns := map[*flight]bool{}
	defer func() {
		mu.Lock()
		defer mu.Unlock()
		for f := range turns {
			g.release(f)
		}
	}()
	responses := map[string]*wsTurn{}
	responseOrder := []string{}
	emit := func(turn *wsTurn, u usage, status int) {
		if turn == nil {
			return
		}
		record := map[string]any{"id": turn.id, "time": turn.began.UTC().Format(time.RFC3339Nano), "method": "WS", "path": "/v1/responses", "keyId": k.ID, "model": turn.requested, "actualModel": turn.entry.Actual, "status": status, "ms": time.Since(turn.began).Milliseconds()}
		if u.Complete {
			record["billing"] = calculateBill(turn.entry.Billing, u)
			if g.audit != nil && turn.entry.Billing.Enabled {
				if g.audit.append(record) != nil {
					g.auditFailed.Store(true)
					cancel()
				}
			}
		}
		if g.record != nil {
			g.record(record)
		}
	}
	remoteDone := make(chan struct{})
	go func() {
		defer close(remoteDone)
		defer cancel()
		var total int64
		for {
			kind, reader, e := remote.NextReader()
			if e != nil {
				return
			}
			b, release, e := g.read(reader, s.cfg.Limits.BodyBytes, s.cfg.Limits.MemoryBytes)
			if e != nil {
				return
			}
			total += int64(len(b))
			if total > s.cfg.Limits.OutputBytes {
				release()
				return
			}
			out := b
			if kind == websocket.TextMessage {
				if v, e := strictJSON(b); e == nil {
					if event, ok := v.(map[string]any); ok {
						mu.Lock()
						responseID, _ := event["response_id"].(string)
						if response, ok := event["response"].(map[string]any); ok {
							if id, ok := response["id"].(string); ok {
								responseID = id
							}
						}
						eventType, _ := event["type"].(string)
						if eventType == "response.created" && responseID != "" && len(pending) > 0 {
							responses[responseID] = pending[0]
							pending = pending[1:]
							responseOrder = append(responseOrder, responseID)
							if len(responseOrder) > 200 {
								delete(responses, responseOrder[0])
								responseOrder = responseOrder[1:]
							}
						}
						turn := responses[responseID]
						if turn == nil && len(pending) > 0 {
							turn = pending[0]
						}
						if turn == nil && current != "" {
							turn = &wsTurn{entry: selected, requested: current}
						}
						if turn != nil {
							rewrite(v, turn.entry.Actual, turn.requested)
							if (eventType == "response.completed" || eventType == "response.failed" || eventType == "response.incomplete" || eventType == "response.cancelled" || eventType == "error") && !turn.settled {
								turn.settled = true
								g.release(turn.flight)
								delete(turns, turn.flight)
								u := usage{Complete: eventType == "response.completed"}
								observe(v, &u)
								if turn.entry.Billing.Enabled {
									observeCost(v, &u, turn.entry.Billing.UsageCostPointer)
								}
								if u.Complete && turn.reserved > 0 && u.Found && u.Tokens <= turn.reserved {
									if g.ledger.Refund(k.ID, turn.reserved-u.Tokens) != nil {
										g.auditFailed.Store(true)
										cancel()
									}
								}
								code := 502
								if u.Complete {
									code = 200
								}
								emit(turn, u, code)
							}
						}
						if eventType == "error" && len(pending) > 0 {
							turn := pending[0]
							pending = pending[1:]
							if !turn.settled {
								turn.settled = true
								emit(turn, usage{}, 502)
								g.release(turn.flight)
								delete(turns, turn.flight)
							}
						}
						mu.Unlock()
						out, _ = json.Marshal(v)
					}
				}
			}
			e = send(kind, out)
			release()
			if e != nil {
				return
			}
		}
	}()
	defer func() { cancel(); remote.Close(); <-remoteDone }()
	for {
		kind, reader, e := local.NextReader()
		if e != nil {
			return
		}
		b, release, e := g.read(reader, s.cfg.Limits.BodyBytes, s.cfg.Limits.MemoryBytes)
		if e != nil {
			return
		}
		if kind != websocket.TextMessage {
			release()
			sendError(400, "Expected a JSON request")
			continue
		}
		v, e := strictJSON(b)
		body, object := v.(map[string]any)
		if e != nil || !object {
			release()
			sendError(400, "Expected a JSON request")
			continue
		}
		policy := g.current.Load()
		if ctx.Err() != nil || policy.accessSignature != s.accessSignature {
			release()
			return
		}
		if body["type"] != "response.cancel" {
			mu.Lock()
			requested := current
			rootName, rootExplicit := body["model"]
			nested, _ := body["response"].(map[string]any)
			nestedName, nestedExplicit := nested["model"]
			if rootExplicit {
				requested, _ = rootName.(string)
			} else if nestedExplicit {
				requested, _ = nestedName.(string)
			}
			entry, code := policy.resolve(k, requested)
			if code == 0 && !policy.cfg.Speech && (speechRequest(r.URL.Path, entry.Actual, body) || speechRequest(r.URL.Path, entry.Actual, nested)) {
				code = 404
			}
			if requested == "" {
				code = 400
			}
			if code == 0 {
				for _, name := range []any{rootName, nestedName} {
					if name == nil {
						continue
					}
					n, ok := name.(string)
					if !ok {
						code = 400
						break
					}
					e, c := policy.resolve(k, n)
					if c != 0 {
						code = c
						break
					}
					if e.ID != entry.ID {
						code = 400
						break
					}
				}
			}
			previous, _ := body["previous_response_id"].(string)
			if p, ok := nested["previous_response_id"].(string); ok {
				previous = p
			}
			if known := responses[previous]; known != nil && known.entry.ID != entry.ID {
				code = 400
			}
			if len(pending) >= 200 {
				code = 429
			}
			if code != 0 {
				mu.Unlock()
				release()
				sendError(code, "Invalid or unavailable model")
				continue
			}
			turnFlight := &flight{cancel: cancel, keyID: k.ID, model: requested, version: policy.cfg.Version}
			if !g.acquire(k, policy, turnFlight) {
				mu.Unlock()
				release()
				sendError(429, "Key concurrency limit reached")
				continue
			}
			if retry := g.takeRequest(k, time.Now()); retry > 0 {
				g.release(turnFlight)
				mu.Unlock()
				release()
				sendError(429, "Key request limit reached")
				continue
			}
			body["model"] = entry.Actual
			if nestedExplicit {
				nested["model"] = entry.Actual
			}
			limitBody := body
			if nested != nil {
				limitBody = nested
			}
			reserved, e := outputLimit(limitBody, "/v1/responses", k)
			if e == nil && reserved > 0 {
				e = g.ledger.Reserve(k.ID, reserved, k.OutputTokens)
			}
			if e != nil {
				g.release(turnFlight)
				mu.Unlock()
				release()
				sendError(429, "Quota unavailable or invalid ceiling")
				continue
			}
			idBytes := make([]byte, 16)
			_, _ = rand.Read(idBytes)
			turn := &wsTurn{entry: entry, requested: requested, id: hex.EncodeToString(idBytes), reserved: reserved, began: time.Now(), flight: turnFlight}
			turns[turnFlight] = true
			pending = append(pending, turn)
			selected = entry
			current = requested
			emit(turn, usage{}, 200)
			mu.Unlock()
			b, _ = json.Marshal(body)
		}
		remote.SetWriteDeadline(time.Now().Add(time.Duration(s.cfg.Limits.WriteSeconds) * time.Second))
		e = remote.WriteMessage(websocket.TextMessage, b)
		release()
		if e != nil {
			return
		}
	}
}
