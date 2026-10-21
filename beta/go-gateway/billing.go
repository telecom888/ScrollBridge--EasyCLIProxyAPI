package main

import (
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strings"
)

type Rates struct {
	Input  string `json:"inputPerMillion"`
	Output string `json:"outputPerMillion"`
	Cached string `json:"cachedInputPerMillion"`
}
type Billing struct {
	Enabled          bool   `json:"enabled"`
	Currency         string `json:"currency"`
	ReadUsagePrice   bool   `json:"readUsagePrice"`
	UsageCostPointer string `json:"usageCostPointer"`
	Rates            Rates  `json:"rates"`
}

var decimalPrice = regexp.MustCompile(`^(0|[1-9][0-9]{0,6})(\.[0-9]{1,9})?$`)

func price(raw string) (*big.Rat, bool) {
	if !decimalPrice.MatchString(raw) {
		return nil, false
	}
	v, ok := new(big.Rat).SetString(raw)
	return v, ok
}
func validateBilling(b *Billing) error {
	if !b.Enabled {
		return nil
	}
	if !regexp.MustCompile(`^[A-Z]{3,8}$`).MatchString(b.Currency) {
		return errors.New("billing currency must be an explicit uppercase unit")
	}
	if b.UsageCostPointer == "" {
		b.UsageCostPointer = "/usage/cost"
	}
	if !strings.HasPrefix(b.UsageCostPointer, "/") || len(b.UsageCostPointer) > 200 {
		return errors.New("invalid usage cost JSON pointer")
	}
	for _, s := range []string{b.Rates.Input, b.Rates.Output, b.Rates.Cached} {
		if _, ok := price(s); !ok {
			return errors.New("prices must be nonnegative decimal strings with up to 9 decimals")
		}
	}
	return nil
}
func usageNumber(m map[string]any, k string) (int64, bool) {
	n, ok := m[k].(json.Number)
	if !ok {
		return 0, false
	}
	i, e := n.Int64()
	return i, e == nil && i >= 0 && i <= 1<<50
}
func observeInput(v any, u *usage) {
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	if x, ok := m["usage"].(map[string]any); ok {
		if n, ok := usageNumber(x, "prompt_tokens"); ok {
			u.Input = max(u.Input, n)
			u.InputFound = true
			if d, ok := x["prompt_tokens_details"].(map[string]any); ok {
				if n, ok := usageNumber(d, "cached_tokens"); ok {
					u.Cached = max(u.Cached, n)
					u.CacheFound = true
				}
			}
		}
		if n, ok := usageNumber(x, "input_tokens"); ok {
			cached, hasCache := usageNumber(x, "cache_read_input_tokens")
			created, _ := usageNumber(x, "cache_creation_input_tokens")
			u.Input = max(u.Input, n+cached+created)
			u.InputFound = true
			if hasCache {
				u.Cached = max(u.Cached, cached)
				u.CacheFound = true
			}
			if d, ok := x["input_tokens_details"].(map[string]any); ok {
				if n, ok := usageNumber(d, "cached_tokens"); ok {
					u.Cached = max(u.Cached, n)
					u.CacheFound = true
				}
			}
		}
	}
	if x, ok := m["usageMetadata"].(map[string]any); ok {
		if n, ok := usageNumber(x, "promptTokenCount"); ok {
			u.Input = max(u.Input, n)
			u.InputFound = true
		}
		if n, ok := usageNumber(x, "cachedContentTokenCount"); ok {
			u.Cached = max(u.Cached, n)
			u.CacheFound = true
		}
	}
	for _, k := range []string{"response", "message"} {
		if x, ok := m[k]; ok {
			observeInput(x, u)
		}
	}
}
func observeCost(v any, u *usage, pointer string) {
	var current any = v
	for _, part := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		m, ok := current.(map[string]any)
		if !ok {
			return
		}
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		current = m[part]
	}
	var raw string
	switch n := current.(type) {
	case json.Number:
		raw = n.String()
	case string:
		raw = n
	default:
		return
	}
	if _, ok := price(raw); ok {
		u.Cost = raw
	}
}
func calculateBill(b Billing, u usage) map[string]any {
	if !b.Enabled {
		return nil
	}
	result := map[string]any{"currency": b.Currency, "source": "manual_rates", "input_tokens": u.Input, "output_tokens": u.Tokens, "cached_input_tokens": u.Cached, "cache_reported": u.CacheFound, "complete": u.Complete, "status": "usage_not_provided"}
	if b.ReadUsagePrice {
		result["source"] = "upstream_usage"
		result["status"] = "price_not_provided"
		if u.Cost != "" {
			result["amount"] = u.Cost
			result["status"] = "reported"
		}
		return result
	}
	if !u.InputFound || !u.Found {
		return result
	}
	if u.Cached > u.Input {
		result["status"] = "invalid_usage"
		return result
	}
	total := new(big.Rat)
	for _, pair := range []struct {
		n int64
		s string
	}{{u.Input - u.Cached, b.Rates.Input}, {u.Tokens, b.Rates.Output}, {u.Cached, b.Rates.Cached}} {
		p, _ := price(pair.s)
		if p == nil {
			result["status"] = "invalid_rates"
			return result
		}
		p.Mul(p, new(big.Rat).SetInt64(pair.n))
		total.Add(total, p)
	}
	total.Quo(total, big.NewRat(1000000, 1))
	result["amount"] = total.FloatString(9)
	result["status"] = "calculated"
	result["rates"] = b.Rates
	return result
}
