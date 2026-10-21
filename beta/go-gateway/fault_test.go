package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSlowReaderHasBoundedWriteTimeAndCancelsSupply(t *testing.T) {
	cancelled := make(chan struct{})
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		frame := "data: " + strings.Repeat("x", 4096) + "\n\n"
		for i := 0; i < 100000; i++ {
			select {
			case <-r.Context().Done():
				close(cancelled)
				return
			default:
			}
			if _, e := io.WriteString(w, frame); e != nil {
				close(cancelled)
				return
			}
			w.(http.Flusher).Flush()
		}
		t.Error("entire huge upstream drained despite non-reading client")
		close(cancelled)
	})
	c := g.current.Load().cfg
	c.Version++
	c.Limits.WriteSeconds = 1
	c.Limits.OutputBytes = 1 << 30
	c.Limits.EventBytes = 16384
	n, e := compile(c)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(n)
	conn, e := net.Dial("tcp", strings.TrimPrefix(s.URL, "http://"))
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	body := `{"model":"chat-alias","stream":true}`
	fmt.Fprintf(conn, "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", testToken, len(body), body)
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("slow client retained supply connection")
	}
	conn.Close()
	waitIdle(t, g)
}
func TestExactStreamTokenCeilingCompletesNormally(t *testing.T) {
	g, s, l := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":10}}\n\ndata: [DONE]\n\n")
	})
	c := g.current.Load().cfg
	c.Version++
	c.Keys[0].OutputTokens = 20
	c.Keys[0].MaxOutputTokens = 10
	n, _ := compile(c)
	g.apply(n)
	code, b := call(t, s, "/v1/chat/completions", `{"model":"chat-alias","stream":true}`)
	if code != 200 || !strings.Contains(string(b), "[DONE]") {
		t.Fatal(code, string(b))
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.used["consumer"] != 10 {
		t.Fatal(l.used)
	}
}
func TestAuditFailureBlocksSubsequentTraffic(t *testing.T) {
	g, s, _ := fixture(t, jsonUp)
	a, e := openAudit(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	g.audit = a
	c := g.current.Load().cfg
	c.Version++
	c.Billing = Billing{Enabled: true, Currency: "USD", Rates: Rates{"1", "2", "0.1"}}
	n, e := compile(c)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(n)
	a.f.Close()
	defer a.lock.Unlock()
	call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"chat-alias"}`)
	if code != 503 || !g.auditFailed.Load() {
		t.Fatal("audit failure was ignored")
	}
}
func TestBillingAuditContainsNoRequestOrSecrets(t *testing.T) {
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"model":"real-model","usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":200},"cost":"99"}}`)
	})
	dir := t.TempDir()
	a, e := openAudit(dir)
	if e != nil {
		t.Fatal(e)
	}
	g.audit = a
	defer a.Close()
	c := g.current.Load().cfg
	c.Version++
	c.Billing = Billing{Enabled: true, Currency: "USD", Rates: Rates{"2", "8", "0.5"}}
	n, _ := compile(c)
	g.apply(n)
	call(t, s, "/v1/chat/completions", `{"model":"chat-alias","prompt":"DO_NOT_LOG_THIS"}`)
	raw, e := os.ReadFile(filepath.Join(dir, "billing.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	text := string(raw)
	if strings.Contains(text, testToken) || strings.Contains(text, "DO_NOT_LOG_THIS") || !strings.Contains(text, "0.002500000") {
		t.Fatal("unsafe or incorrect billing audit")
	}
	if len(strings.Split(strings.TrimSpace(text), "\n")) != 1 {
		t.Fatal("unexpected record count")
	}
}
func TestSSETerminalEventIsDeliveredBeforeEOF(t *testing.T) {
	g, s, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: [DONE]\n\n")
		w.(http.Flusher).Flush()
	})
	r, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"model":"chat-alias","stream":true}`))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	resp, e := s.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	line, e := bufio.NewReader(resp.Body).ReadString('\n')
	resp.Body.Close()
	if e != nil || line != "data: [DONE]\n" {
		t.Fatal(line, e)
	}
	waitIdle(t, g)
}

func TestAliasGrantsAreIndependentAndSurviveRename(t *testing.T) {
	g, s, _ := fixture(t, jsonUp)
	c := g.current.Load().cfg
	c.Version++
	c.Models[0].ExposureIDs = map[string]string{"chat-alias": "exposure-chat", "real-model": "exposure-original", "second-alias": "exposure-second"}
	c.Keys[0].Mode = "selected"
	c.Keys[0].Allowed = []string{"exposure-chat"}
	n, e := compile(c)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(n)
	for _, test := range []struct {
		name   string
		status int
	}{{"chat-alias", 200}, {"second-alias", 403}, {"real-model", 403}} {
		code, _ := call(t, s, "/v1/chat/completions", `{"model":"`+test.name+`"}`)
		if code != test.status {
			t.Fatal(test, code)
		}
	}
	c.Version++
	c.Models[0].Aliases = []string{"renamed", "second-alias"}
	delete(c.Models[0].ExposureIDs, "chat-alias")
	c.Models[0].ExposureIDs["renamed"] = "exposure-chat"
	n, e = compile(c)
	if e != nil {
		t.Fatal(e)
	}
	g.apply(n)
	code, _ := call(t, s, "/v1/chat/completions", `{"model":"renamed"}`)
	if code != 200 {
		t.Fatal(code)
	}
}

func TestTCPAdmissionRejectsExcessIdleConnections(t *testing.T) {
	raw, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	l := limitConnections(raw, 1)
	defer l.Close()
	accepted := make(chan net.Conn, 2)
	go func() {
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			accepted <- c
		}
	}()
	one, e := net.Dial("tcp", raw.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	defer one.Close()
	first := <-accepted
	defer first.Close()
	two, e := net.Dial("tcp", raw.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	two.SetReadDeadline(time.Now().Add(time.Second))
	_, e = two.Read(make([]byte, 1))
	two.Close()
	if e == nil {
		t.Fatal("excess idle connection admitted")
	}
	first.Close()
	third, e := net.Dial("tcp", raw.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	defer third.Close()
	select {
	case c := <-accepted:
		c.Close()
	case <-time.After(time.Second):
		t.Fatal("slot not released")
	}
}
