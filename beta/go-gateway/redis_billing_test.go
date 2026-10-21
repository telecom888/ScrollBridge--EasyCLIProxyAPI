package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func TestRedisCASSharedQuotaAndMissedNotifications(t *testing.T) {
	redis := miniredis.RunT(t)
	a, e := newRedis("redis://" + redis.Addr())
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, _ := newRedis("redis://" + redis.Addr())
	defer b.Close()
	c := fixtureConfig("http://127.0.0.1:1")
	s, _ := compile(c)
	raw, _ := json.Marshal(c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if e = a.publish(ctx, s, raw); e != nil {
		t.Fatal(e)
	}
	if a.publish(ctx, s, raw) == nil {
		t.Fatal("duplicate version accepted")
	}
	loaded, e := b.load(ctx)
	if e != nil || loaded.cfg.Version != 1 {
		t.Fatal(e)
	}
	g := newGateway(loaded, b)
	defer g.transport.CloseIdleConnections()
	go watch(ctx, g, b.load, nil) // Deliberately no Pub/Sub subscription.
	c.Version = 2
	c.Models[0].Enabled = false
	s, _ = compile(c)
	raw, _ = json.Marshal(c)
	if e = a.publish(ctx, s, raw); e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(2 * time.Second)
	for g.current.Load().cfg.Version < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond * 10)
	}
	if g.current.Load().cfg.Version != 2 {
		t.Fatal("polling failed to recover missed notification")
	}
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			store := a
			if i%2 == 0 {
				store = b
			}
			if store.Reserve("tenant", 10, 100) == nil {
				accepted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if accepted.Load() != 10 {
		t.Fatal(accepted.Load())
	}
	if e = a.Refund("tenant", 3); e != nil {
		t.Fatal(e)
	}
	if e = b.Reserve("tenant", 3, 100); e != nil {
		t.Fatal(e)
	}
	if b.Reserve("tenant", 1, 100) == nil {
		t.Fatal("shared quota overspent")
	}
	if b.Refund("tenant", 101) == nil {
		t.Fatal("invalid refund accepted")
	}
}
func TestRedisConfigurationRejectsTampering(t *testing.T) {
	redis := miniredis.RunT(t)
	r, _ := newRedis("redis://" + redis.Addr())
	defer r.Close()
	ctx := context.Background()
	if _, e := r.load(ctx); e == nil {
		t.Fatal("missing config accepted")
	}
	redis.HSet(redisConfigKey, "version", "2", "blob", `{"version":1}`)
	if _, e := r.load(ctx); e == nil {
		t.Fatal("bad config accepted")
	}
}
func TestUsagePriceSwitchAndManualRates(t *testing.T) {
	b := Billing{Enabled: true, Currency: "USD", Rates: Rates{"2", "8", "0.5"}}
	if e := validateBilling(&b); e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		name, body string
		amount     string
	}{
		{"OpenAI", `{"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":200},"cost":"99"}}`, "0.002500000"},
		{"Anthropic", `{"usage":{"input_tokens":800,"cache_read_input_tokens":200,"output_tokens":100}}`, "0.002500000"},
		{"Gemini", `{"usageMetadata":{"promptTokenCount":1000,"cachedContentTokenCount":200,"candidatesTokenCount":100}}`, "0.002500000"},
		{"Responses", `{"response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":200},"output_tokens":100}}}`, "0.002500000"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, e := strictJSON([]byte(tc.body))
			if e != nil {
				t.Fatal(e)
			}
			u := usage{Complete: true}
			observe(v, &u)
			observeCost(v, &u, b.UsageCostPointer)
			bill := calculateBill(b, u)
			if bill["amount"] != tc.amount {
				t.Fatal(bill)
			}
			if tc.name == "OpenAI" {
				b2 := b
				b2.ReadUsagePrice = true
				bill = calculateBill(b2, u)
				if bill["amount"] != "99" || bill["source"] != "upstream_usage" {
					t.Fatal(bill)
				}
			}
		})
	}
	b.ReadUsagePrice = true
	bill := calculateBill(b, usage{})
	if _, ok := bill["amount"]; ok || bill["status"] != "price_not_provided" {
		t.Fatal(bill)
	}
	b.ReadUsagePrice = false
	bill = calculateBill(b, usage{})
	if _, ok := bill["amount"]; ok || bill["status"] != "usage_not_provided" {
		t.Fatal(bill)
	}
}
func TestSSEUsageFramingAndCompletion(t *testing.T) {
	for _, frame := range []string{
		"data: {\"usage\":{\"output_tokens\":3}}\r\rdata: [DONE]\r\r",
		"data: {\"model\":\"real-model\",\n" + "data: \"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"cost\":\"0.2\"}}\n\ndata: [DONE]\n\n",
		"event: message_delta\r\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\r\n\r\nevent: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n",
		"data: {\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"candidatesTokenCount\":3}}\n\n",
	} {
		u := usage{}
		rec := newStreamRecorder()
		e := entry{Name: "alias", Actual: "real-model", Billing: Billing{Enabled: true, UsageCostPointer: "/usage/cost"}}
		err := streamSSE(&deadlineWriter{w: rec, seconds: 1, limit: 10000}, strings.NewReader(frame), e, 4096, &u, 0)
		if err != nil || !u.Found || !u.Complete || u.Tokens != 3 {
			t.Fatalf("%+v %v", u, err)
		}
	}
}
func TestHalfOpenAllowsOneProbeAndOldSuccessCannotResetCooldown(t *testing.T) {
	p := newPool()
	list := []Upstream{{ID: "one"}}
	_, success, _ := p.pick(list)
	_, failure, _ := p.pick(list)
	failure(429, nil, nil)
	success(200, nil, nil)
	if _, _, ok := p.pick(list); ok {
		t.Fatal("older success cleared newer failure")
	}
	p.mu.Lock()
	p.states["one"].until = time.Now().Add(-time.Second)
	p.mu.Unlock()
	_, done, ok := p.pick(list)
	if !ok {
		t.Fatal("no half-open probe")
	}
	if _, _, ok = p.pick(list); ok {
		t.Fatal("multiple half-open probes")
	}
	done(200, nil, nil)
	if _, finish, ok := p.pick(list); !ok {
		t.Fatal("not recovered")
	} else {
		finish(200, nil, nil)
	}
}
func TestQuotaTokenFieldValidation(t *testing.T) {
	for _, path := range []string{"/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1beta/models/alias:generateContent"} {
		v, _ := strictJSON([]byte(`{"max_tokens":200}`))
		n, e := outputLimit(v.(map[string]any), path, &Key{OutputTokens: 1000, MaxOutputTokens: 100})
		if e != nil || n != 100 {
			t.Fatal(path, n, e)
		}
	}
	for _, s := range []string{`{"max_tokens":-1}`, `{"max_tokens":1.5}`, `{"max_tokens":"2"}`} {
		v, _ := strictJSON([]byte(s))
		if _, e := outputLimit(v.(map[string]any), "/v1/messages", &Key{OutputTokens: 10, MaxOutputTokens: 10}); e == nil {
			t.Fatal(s)
		}
	}
}
func TestPricingConfigValidation(t *testing.T) {
	for _, input := range []string{"-1", "NaN", "1e6", "1.1234567890", "99999999"} {
		b := Billing{Enabled: true, Currency: "USD", Rates: Rates{input, "1", "1"}}
		if validateBilling(&b) == nil {
			t.Fatal(input)
		}
	}
	c := fixtureConfig("http://127.0.0.1:1")
	c.Billing = Billing{Enabled: true, Currency: "USD", Rates: Rates{"2", "8", "0.5"}}
	c.Models[0].Rates = &Rates{"4", "16", "1"}
	s, e := compile(c)
	if e != nil {
		t.Fatal(e)
	}
	if s.names["chat-alias"].Billing.Rates.Input != "4" {
		t.Fatal("model price override lost")
	}
}

type streamRecorder struct {
	header map[string][]string
	data   strings.Builder
}

func newStreamRecorder() *streamRecorder              { return &streamRecorder{header: map[string][]string{}} }
func (r *streamRecorder) Header() http.Header         { return r.header }
func (r *streamRecorder) WriteHeader(int)             {}
func (r *streamRecorder) Write(p []byte) (int, error) { return r.data.Write(p) }
func (r *streamRecorder) Flush()                      {}
