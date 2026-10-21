package main

import (
	"net/http"
	"os"
	"strings"
)

func supplyCredentials(req *http.Request, u Upstream) {
	key := os.Getenv(u.KeyEnv)
	if key == "" {
		return
	}
	if u.Auth == "bearer" {
		req.Header.Set("Authorization", "Bearer "+key)
		return
	}
	if strings.HasPrefix(req.URL.Path, "/v1beta/") {
		req.Header.Set("X-Goog-API-Key", key)
	} else if strings.HasPrefix(req.URL.Path, "/v1/messages") {
		req.Header.Set("X-API-Key", key)
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
}
