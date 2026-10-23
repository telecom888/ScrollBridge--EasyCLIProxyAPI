package main

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"time"
)

const requestBodyPreviewLimit = 16 * 1024

// Capture only a bounded prefix while the existing parser reads the unchanged
// body. Rejected requests get a short, bounded drain so scanners are visible too.
type requestBodyCapture struct {
	io.ReadCloser
	prefix    []byte
	readBytes int64
	eof       bool
	failed    bool
}

func (c *requestBodyCapture) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	c.readBytes += int64(n)
	if remaining := requestBodyPreviewLimit + 1 - len(c.prefix); remaining > 0 {
		c.prefix = append(c.prefix, p[:min(n, remaining)]...)
	}
	if err == io.EOF {
		c.eof = true
	} else if err != nil {
		c.failed = true
	}
	return n, err
}

func bodyPreview(data []byte, contentType, encoding string, incomplete bool) map[string]any {
	contentType = contentType[:min(len(contentType), 256)]
	encoding = encoding[:min(len(encoding), 64)]
	result := map[string]any{"contentType": contentType, "encoding": encoding, "truncated": incomplete || len(data) > requestBodyPreviewLimit}
	if encoding != "" && encoding != "identity" {
		reader, close, err := decodeReader(bytes.NewReader(data), encoding)
		if err != nil {
			result["state"] = "encoded"
			return result
		}
		defer close()
		decoded, err := io.ReadAll(io.LimitReader(reader, requestBodyPreviewLimit+1))
		if err != nil {
			result["truncated"] = true
		}
		data = decoded
		if len(data) > requestBodyPreviewLimit {
			result["truncated"] = true
		}
	}
	if len(data) == 0 {
		if incomplete {
			result["state"] = "unavailable"
		} else {
			result["state"] = "empty"
		}
		return result
	}
	if strings.HasPrefix(contentType, "image/") || strings.HasPrefix(contentType, "audio/") || strings.HasPrefix(contentType, "video/") || strings.HasPrefix(contentType, "multipart/") || contentType == "application/octet-stream" || bytes.IndexByte(data, 0) >= 0 {
		result["state"] = "binary"
		return result
	}
	result["state"] = "text"
	result["preview"] = strings.ToValidUTF8(string(data[:min(len(data), requestBodyPreviewLimit)]), "�")
	return result
}

func (g *gateway) captureRequestBody(r *http.Request) (*requestBodyCapture, func()) {
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		return nil, func() {}
	}
	limit := g.current.Load().cfg.Limits.MemoryBytes
	if !g.mem(requestBodyPreviewLimit+1, limit) {
		return nil, func() {}
	}
	c := &requestBodyCapture{ReadCloser: r.Body, prefix: make([]byte, 0, requestBodyPreviewLimit+1)}
	r.Body = c
	return c, func() { g.mem(-(requestBodyPreviewLimit + 1), limit) }
}

func (c *requestBodyCapture) finish(w http.ResponseWriter, r *http.Request) map[string]any {
	if !c.eof && !c.failed && len(c.prefix) <= requestBodyPreviewLimit && r.Header.Get("Expect") == "" {
		controller := http.NewResponseController(w)
		if controller.SetReadDeadline(time.Now().Add(150*time.Millisecond)) == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(c, int64(requestBodyPreviewLimit+1-len(c.prefix))))
			if c.eof || (r.ContentLength >= 0 && c.readBytes == r.ContentLength) {
				_ = controller.SetReadDeadline(time.Time{})
			}
		}
	}
	complete := c.eof || (r.ContentLength >= 0 && c.readBytes == r.ContentLength)
	result := bodyPreview(c.prefix, r.Header.Get("Content-Type"), r.Header.Get("Content-Encoding"), !complete)
	result["readBytes"] = c.readBytes
	return result
}
