package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

func (g *gateway) modelDirectory(ctx context.Context, s *snapshot, k *Key, path string) ([]byte, int, error) {
	supply, done, ok := g.pool.pick(s.cfg.Upstreams)
	if !ok {
		return nil, 503, errors.New("all upstreams cooling down")
	}
	target, _ := url.Parse(supply.URL)
	target.Path = path
	req, _ := http.NewRequestWithContext(ctx, "GET", target.String(), nil)
	req.Header.Set("Accept-Encoding", "identity")
	supplyCredentials(req, supply)
	response, err := g.transport.RoundTrip(req)
	if err != nil {
		done(502, nil, err)
		return nil, 502, err
	}
	defer response.Body.Close()
	defer done(response.StatusCode, response.Header, nil)
	reader, close, e := decodeReader(response.Body, response.Header.Get("Content-Encoding"))
	if e != nil {
		return nil, 502, e
	}
	defer close()
	raw, free, e := g.read(reader, 4<<20, s.cfg.Limits.MemoryBytes)
	if e != nil {
		return nil, 502, e
	}
	defer free()
	if response.StatusCode >= 400 {
		return nil, response.StatusCode, errors.New("upstream model directory unavailable")
	}
	v, e := strictJSON(raw)
	if e != nil {
		return nil, 502, e
	}
	object, ok := v.(map[string]any)
	if !ok {
		return nil, 502, errors.New("invalid model directory")
	}
	field := "data"
	if strings.HasPrefix(path, "/v1beta/") {
		field = "models"
	}
	models, ok := object[field].([]any)
	if !ok {
		return nil, 502, errors.New("invalid model directory")
	}
	out := []any{}
	for _, row := range models {
		model, ok := row.(map[string]any)
		if !ok {
			continue
		}
		id, _ := model["id"].(string)
		if field == "models" {
			id, _ = model["name"].(string)
		}
		for _, entry := range s.ordered {
			if normalized(entry.Actual) != normalized(id) {
				continue
			}
			if _, code := s.resolve(k, entry.Name); code != 0 {
				continue
			}
			copy := map[string]any{}
			for key, value := range model {
				copy[key] = value
			}
			if field == "data" {
				copy["id"] = entry.Name
			} else {
				copy["name"] = "models/" + entry.Name
				if _, ok = copy["displayName"]; ok {
					copy["displayName"] = entry.Name
				}
			}
			out = append(out, copy)
		}
	}
	object[field] = out
	delete(object, "nextPageToken")
	b, e := json.Marshal(object)
	return b, 200, e
}
