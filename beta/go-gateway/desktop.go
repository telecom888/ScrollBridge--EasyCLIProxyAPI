package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

type desktopMessage struct {
	ID     uint64          `json:"id"`
	Action string          `json:"action"`
	Config json.RawMessage `json:"config"`
}

func runDesktop(state string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var outMu sync.Mutex
	send := func(v any) {
		outMu.Lock()
		defer outMu.Unlock()
		if json.NewEncoder(os.Stdout).Encode(v) != nil {
			cancel()
		}
	}
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), (4<<20)+4096)
	if !scan.Scan() {
		return errors.New("desktop configuration not received")
	}
	var init desktopMessage
	if json.Unmarshal(scan.Bytes(), &init) != nil || init.Action != "init" {
		return errors.New("invalid desktop initialization")
	}
	s, err := decodeConfig(init.Config)
	if err != nil {
		send(map[string]any{"id": init.ID, "error": "网关配置无效"})
		return errors.New("invalid desktop policy")
	}
	l, err := openLedger(state)
	if err != nil {
		return err
	}
	defer l.Close()
	a, err := openAudit(state)
	if err != nil {
		return err
	}
	defer a.Close()
	g := newGateway(s, l)
	g.audit = a
	g.record = func(v map[string]any) { send(map[string]any{"event": "record", "record": v}) }
	server := serverFor(g)
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return errors.New("网关端口无法监听")
	}
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()
	defer func() {
		g.stale.Store(true)
		g.mu.Lock()
		for f := range g.active {
			f.cancel()
		}
		g.mu.Unlock()
		server.Close()
		g.transport.CloseIdleConnections()
	}()
	send(map[string]any{"id": init.ID, "ok": true, "event": "ready", "version": s.cfg.Version})
	go func() {
		defer cancel()
		for scan.Scan() {
			var m desktopMessage
			if json.Unmarshal(scan.Bytes(), &m) != nil {
				send(map[string]any{"error": "invalid control message"})
				continue
			}
			var err error
			switch m.Action {
			case "reload":
				var n *snapshot
				n, err = decodeConfig(m.Config)
				if err == nil {
					err = g.apply(n)
				}
			case "metrics":
				send(map[string]any{"id": m.ID, "ok": true, "metrics": g.metrics()})
				continue
			case "stop":
				send(map[string]any{"id": m.ID, "ok": true})
				return
			default:
				err = errors.New("unknown action")
			}
			if err != nil {
				send(map[string]any{"id": m.ID, "error": "网关配置更新失败"})
			} else {
				send(map[string]any{"id": m.ID, "ok": true, "version": g.current.Load().cfg.Version})
			}
		}
	}()
	select {
	case <-ctx.Done():
	case err = <-result:
		if err != nil && err != http.ErrServerClosed {
			return fmt.Errorf("desktop gateway stopped")
		}
	}
	timeout, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	_ = server.Shutdown(timeout)
	return nil
}

// Unwrap retains Flush/deadline support. Hijack is needed by the WS upgrader.
type recordWriter struct {
	http.ResponseWriter
	status       int
	writeSeconds int
}

func (w *recordWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *recordWriter) WriteHeader(n int) {
	if w.status == 0 {
		if w.writeSeconds > 0 {
			_ = http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Now().Add(time.Duration(w.writeSeconds) * time.Second))
		}
		w.status = n
	}
	w.ResponseWriter.WriteHeader(n)
}
func (w *recordWriter) Write(b []byte) (int, error) {
	if w.writeSeconds > 0 {
		_ = http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Now().Add(time.Duration(w.writeSeconds) * time.Second))
	}
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *recordWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, io.ErrUnexpectedEOF
	}
	c, b, e := h.Hijack()
	if e == nil {
		w.status = 101
	}
	return c, b, e
}
