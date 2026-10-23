package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRejectedSlowBodyDoesNotHoldRequestOpen(t *testing.T) {
	g, server, _ := fixture(t, func(http.ResponseWriter, *http.Request) { t.Error("scanner reached upstream") })
	rows := make(chan map[string]any, 1)
	g.record = func(row map[string]any) { rows <- row }
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	io.WriteString(conn, "POST /app HTTP/1.1\r\nHost: fixture\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{")
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	select {
	case row := <-rows:
		if row["requestBody"].(map[string]any)["truncated"] != true {
			t.Fatal(row)
		}
	case <-time.After(time.Second):
		t.Fatal("capture did not time out")
	}
}

func TestBodyPreviewRejectedRequestsAreBoundedAndDoNotReachUpstream(t *testing.T) {
	g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unauthenticated request reached upstream") })
	rows := make(chan map[string]any, 8)
	g.record = func(row map[string]any) { rows <- row }
	for _, data := range []string{`{"probe":"<script>never execute</script>"}`, strings.Repeat("x", requestBodyPreviewLimit*3)} {
		req, _ := http.NewRequest("POST", server.URL+"/app", strings.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Fatal(res.StatusCode)
		}
		select {
		case row := <-rows:
			body := row["requestBody"].(map[string]any)
			preview, _ := body["preview"].(string)
			if len(preview) > requestBodyPreviewLimit || preview != data[:min(len(data), requestBodyPreviewLimit)] {
				t.Fatal(body)
			}
			if body["truncated"] != (len(data) > requestBodyPreviewLimit) {
				t.Fatal(body)
			}
		case <-time.After(time.Second):
			t.Fatal("no captured request")
		}
	}
}

func TestBodyPreviewDoesNotAlterForwardedRequestsAndBoundsDecompression(t *testing.T) {
	payload := `{"model":"real-model","messages":[{"role":"user","content":"unchanged"}]}`
	rows := make(chan map[string]any, 2)
	g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if string(b) != payload {
			t.Errorf("upstream body changed: %s", b)
		}
		w.Write([]byte(`{"choices":[]}`))
	})
	g.record = func(row map[string]any) { rows <- row }
	req, _ := http.NewRequest("POST", server.URL+"/v1/chat/completions", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	select {
	case row := <-rows:
		if row["requestBody"].(map[string]any)["preview"] != payload {
			t.Fatal(row)
		}
	case <-time.After(time.Second):
		t.Fatal("no record")
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	writer.Write(bytes.Repeat([]byte("z"), 1024*1024))
	writer.Close()
	preview := bodyPreview(compressed.Bytes(), "text/plain", "gzip", false)
	if len(preview["preview"].(string)) != requestBodyPreviewLimit || preview["truncated"] != true {
		t.Fatal(preview)
	}
	if got := bodyPreview([]byte{1, 0, 2}, "image/png", "", false); got["state"] != "binary" || got["preview"] != nil {
		t.Fatal(got)
	}
}
