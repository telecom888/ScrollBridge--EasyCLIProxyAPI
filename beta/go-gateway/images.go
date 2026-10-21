package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var geminiImagePattern = regexp.MustCompile(`(?i)^gemini-[a-z0-9.-]*image[a-z0-9.-]*$`)

func isGeminiImage(s string) bool { return geminiImagePattern.MatchString(s) }
func imageSize(value any) (map[string]any, error) {
	s, _ := value.(string)
	if value == nil || s == "" || strings.EqualFold(s, "auto") {
		return nil, nil
	}
	upper := strings.ToUpper(s)
	for _, v := range []string{"512", "1K", "2K", "4K"} {
		if upper == v {
			return map[string]any{"imageSize": upper}, nil
		}
	}
	var w, h int
	if !regexp.MustCompile(`(?i)^[0-9]{3,4}x[0-9]{3,4}$`).MatchString(s) {
		return nil, errors.New("invalid image dimensions")
	}
	if _, e := fmt.Sscanf(strings.ToLower(s), "%dx%d", &w, &h); e != nil || w < 256 || h < 256 || w > 8192 || h > 8192 {
		return nil, errors.New("invalid image dimensions")
	}
	ratio := ""
	for _, r := range []string{"1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"} {
		var a, b float64
		fmt.Sscanf(r, "%f:%f", &a, &b)
		if math.Abs(float64(w)/float64(h)-a/b)/(a/b) < .025 {
			ratio = r
			break
		}
	}
	if ratio == "" {
		return nil, errors.New("unsupported aspect ratio")
	}
	bucket := "1K"
	if math.Sqrt(float64(w*h)) > 3000 {
		bucket = "4K"
	} else if math.Sqrt(float64(w*h)) > 1500 {
		bucket = "2K"
	}
	return map[string]any{"aspectRatio": ratio, "imageSize": bucket}, nil
}
func imagePlan(actual string, m map[string]any, files []upload, editing bool) (map[string]any, int, error) {
	prompt, ok := m["prompt"].(string)
	if !ok || strings.TrimSpace(prompt) == "" {
		return nil, 0, errors.New("prompt is required")
	}
	count := 1
	if n, present := m["n"]; present {
		switch v := n.(type) {
		case json.Number:
			i, e := v.Int64()
			if e != nil {
				return nil, 0, e
			}
			count = int(i)
		case string:
			i, e := strconv.Atoi(v)
			if e != nil {
				return nil, 0, e
			}
			count = i
		default:
			return nil, 0, errors.New("invalid image count")
		}
	}
	if count < 1 || count > 4 {
		return nil, 0, errors.New("image count must be 1..4")
	}
	if f, exists := m["response_format"]; exists && f != "" && f != "b64_json" {
		return nil, 0, errors.New("only b64_json is supported")
	}
	if m["stream"] == true || m["stream"] == "true" {
		return nil, 0, errors.New("streaming image conversion is unsupported")
	}
	for _, k := range []string{"mask", "quality", "background", "output_format", "output_compression", "input_fidelity", "partial_images"} {
		if v, ok := m[k]; ok && v != "auto" {
			return nil, 0, errors.New("unsupported image option")
		}
	}
	parts := []any{map[string]any{"text": prompt}}
	add := func(mime, data string) error {
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
			return errors.New("unsupported reference image")
		}
		if data == "" {
			return errors.New("empty reference")
		}
		if _, e := base64.StdEncoding.Strict().DecodeString(data); e != nil {
			return errors.New("invalid base64 reference")
		}
		parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": mime, "data": data}})
		return nil
	}
	for _, f := range files {
		if f.Name != "image" && f.Name != "image[]" {
			return nil, 0, errors.New("only reference images may be uploaded")
		}
		if e := add(f.Mime, base64.StdEncoding.EncodeToString(f.Data)); e != nil {
			return nil, 0, e
		}
	}
	refs := []any{}
	if v, ok := m["image"]; ok {
		if a, ok := v.([]any); ok {
			refs = append(refs, a...)
		} else {
			refs = append(refs, v)
		}
	}
	if v, ok := m["images"]; ok {
		a, ok := v.([]any)
		if !ok {
			return nil, 0, errors.New("images must be an array")
		}
		for _, v := range a {
			if x, ok := v.(map[string]any); ok {
				v = x["image_url"]
			}
			refs = append(refs, v)
		}
	}
	for _, ref := range refs {
		s, ok := ref.(string)
		if !ok || !strings.HasPrefix(s, "data:") {
			return nil, 0, errors.New("references must be data URLs")
		}
		metadata, data, ok := strings.Cut(strings.TrimPrefix(s, "data:"), ";base64,")
		if !ok {
			return nil, 0, errors.New("invalid data URL")
		}
		if e := add(metadata, data); e != nil {
			return nil, 0, e
		}
	}
	if editing && len(parts) == 1 {
		return nil, 0, errors.New("reference image required")
	}
	if len(parts) > 15 {
		return nil, 0, errors.New("too many reference images")
	}
	size, e := imageSize(m["size"])
	if e != nil {
		return nil, 0, e
	}
	if strings.HasPrefix(strings.ToLower(actual), "gemini-2.5-") {
		delete(size, "imageSize")
	}
	generation := map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}}
	if len(size) > 0 {
		generation["imageConfig"] = size
	}
	return map[string]any{"contents": []any{map[string]any{"role": "user", "parts": parts}}, "generationConfig": generation}, count, nil
}
func (g *gateway) generateImages(ctx context.Context, s *snapshot, supply Upstream, m map[string]any, files []upload, editing bool) ([]byte, int, usage, error) {
	u := usage{}
	actual, _ := m["model"].(string)
	plan, count, e := imagePlan(actual, m, files, editing)
	if e != nil {
		return nil, 400, u, e
	}
	payload, _ := json.Marshal(plan)
	var images []any
	var total int64
	var input, output, cached int64
	usageCost := new(big.Rat)
	allCosts := true
	// Keep the largest possible transformed image result within the shared budget.
	workspace := s.cfg.Limits.ResponseBytes * 2
	if !g.mem(workspace, s.cfg.Limits.MemoryBytes) {
		return nil, 503, u, errors.New("image result budget")
	}
	defer g.mem(-workspace, s.cfg.Limits.MemoryBytes)
	for i := 0; i < count; i++ {
		target, _ := url.Parse(supply.URL)
		target.Path = "/v1beta/models/" + actual + ":generateContent"
		req, e := http.NewRequestWithContext(ctx, "POST", target.String(), bytes.NewReader(payload))
		if e != nil {
			return nil, 502, u, e
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept-Encoding", "identity")
		if key := os.Getenv(supply.KeyEnv); key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("X-Goog-API-Key", key)
		}
		response, e := g.transport.RoundTrip(req)
		if e != nil {
			return nil, 502, u, e
		}
		reader, close, e := decodeReader(response.Body, response.Header.Get("Content-Encoding"))
		if e != nil {
			response.Body.Close()
			return nil, 502, u, e
		}
		b, release, e := g.read(reader, s.cfg.Limits.ResponseBytes, s.cfg.Limits.MemoryBytes)
		close()
		response.Body.Close()
		if e != nil {
			return nil, 502, u, e
		}
		v, e := strictJSON(b)
		if e != nil {
			release()
			return nil, 502, u, e
		}
		if response.StatusCode >= 400 {
			release()
			message := "upstream image error"
			if object, ok := v.(map[string]any); ok {
				if data, ok := object["error"].(map[string]any); ok {
					if text, ok := data["message"].(string); ok && len(text) < 1024 {
						message = text
					}
				}
			}
			if secret := os.Getenv(supply.KeyEnv); secret != "" {
				message = strings.ReplaceAll(message, secret, "[redacted]")
			}
			return nil, response.StatusCode, u, errors.New(message)
		}
		one := usage{}
		observe(v, &one)
		input += one.Input
		output += one.Tokens
		cached += one.Cached
		if i == 0 {
			u.InputFound = one.InputFound
			u.Found = one.Found
			u.CacheFound = one.CacheFound
		} else {
			u.InputFound = u.InputFound && one.InputFound
			u.Found = u.Found && one.Found
			u.CacheFound = u.CacheFound && one.CacheFound
		}
		u.Input = input
		u.Tokens = output
		u.Cached = cached
		if s.cfg.Billing.Enabled {
			observeCost(v, &one, s.cfg.Billing.UsageCostPointer)
		}
		if one.Cost == "" {
			allCosts = false
		} else if amount, ok := price(one.Cost); ok {
			usageCost.Add(usageCost, amount)
		} else {
			allCosts = false
		}
		if allCosts {
			u.Cost = usageCost.FloatString(9)
		} else {
			u.Cost = ""
		}
		root, ok := v.(map[string]any)
		if !ok {
			release()
			return nil, 502, u, errors.New("invalid image response")
		}
		candidates, _ := root["candidates"].([]any)
		var data, mime string
		for _, c := range candidates {
			candidate, _ := c.(map[string]any)
			content, _ := candidate["content"].(map[string]any)
			parts, _ := content["parts"].([]any)
			for _, p := range parts {
				part, _ := p.(map[string]any)
				if part["thought"] == true {
					continue
				}
				inline, _ := part["inlineData"].(map[string]any)
				if inline == nil {
					inline, _ = part["inline_data"].(map[string]any)
				}
				if inline != nil {
					data, _ = inline["data"].(string)
					mime, _ = inline["mimeType"].(string)
					if mime == "" {
						mime, _ = inline["mime_type"].(string)
					}
					if data != "" {
						break
					}
				}
			}
			if data != "" {
				break
			}
		}
		if data == "" || (mime != "image/png" && mime != "image/jpeg" && mime != "image/webp") {
			release()
			return nil, 502, u, errors.New("no final image")
		}
		if _, e = base64.StdEncoding.Strict().DecodeString(data); e != nil {
			release()
			return nil, 502, u, errors.New("invalid image data")
		}
		total += int64(len(data))
		if total > s.cfg.Limits.ResponseBytes {
			release()
			return nil, 502, u, errors.New("combined result limit")
		}
		images = append(images, map[string]any{"b64_json": data, "output_format": strings.TrimPrefix(mime, "image/")})
		release()
	}
	u.Input = input
	u.Tokens = output
	u.Cached = cached
	u.Complete = true
	b, e := json.Marshal(map[string]any{"created": time.Now().Unix(), "data": images})
	if int64(len(b)) > s.cfg.Limits.OutputBytes {
		return nil, 502, u, errors.New("image output limit")
	}
	return b, 200, u, e
}
