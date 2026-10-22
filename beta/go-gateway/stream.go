package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

type usage struct {
	Tokens                 int64
	Found                  bool
	Complete               bool
	Input, Cached          int64
	InputFound, CacheFound bool
	Cost                   string
}

func observe(v any, u *usage) {
	observeInput(v, u)
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	if x, ok := m["usage"].(map[string]any); ok {
		for _, k := range []string{"output_tokens", "completion_tokens"} {
			if n, ok := x[k].(json.Number); ok {
				i, e := n.Int64()
				if e == nil && i >= 0 {
					u.Tokens = max(u.Tokens, i)
					u.Found = true
				}
			}
		}
	}
	if x, ok := m["usageMetadata"].(map[string]any); ok {
		if n, ok := x["candidatesTokenCount"].(json.Number); ok {
			i, e := n.Int64()
			if e == nil && i >= 0 {
				u.Tokens = max(u.Tokens, i)
				u.Found = true
			}
		}
	}
	for _, k := range []string{"response", "message"} {
		if x, ok := m[k]; ok {
			observe(x, u)
		}
	}
}
func rewrite(v any, actual, exposed string) {
	if actual == exposed {
		return
	}
	if list, ok := v.([]any); ok {
		for _, row := range list {
			rewrite(row, actual, exposed)
		}
		return
	}
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	for _, k := range []string{"model", "modelVersion"} {
		if _, ok := m[k].(string); ok {
			m[k] = exposed
		}
	}
	for _, k := range []string{"response", "message"} {
		if x, ok := m[k]; ok {
			rewrite(x, actual, exposed)
		}
	}
}

// Reject duplicate fields, including escaped spellings. Different JSON parsers
// must never disagree about which model or max-token constraint was authorized.
func strictJSON(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var walk func(int) (any, error)
	walk = func(depth int) (any, error) {
		if depth > 64 {
			return nil, errors.New("JSON nesting limit")
		}
		t, e := d.Token()
		if e != nil {
			return nil, e
		}
		switch t {
		case json.Delim('{'):
			m := map[string]any{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return nil, e
				}
				key, ok := k.(string)
				if !ok {
					return nil, errors.New("invalid object")
				}
				if _, ok = m[key]; ok {
					return nil, errors.New("duplicate JSON field")
				}
				v, e := walk(depth + 1)
				if e != nil {
					return nil, e
				}
				m[key] = v
			}
			_, e = d.Token()
			return m, e
		case json.Delim('['):
			a := []any{}
			for d.More() {
				v, e := walk(depth + 1)
				if e != nil {
					return nil, e
				}
				a = append(a, v)
			}
			_, e = d.Token()
			return a, e
		default:
			return t, nil
		}
	}
	v, e := walk(0)
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, errors.New("trailing JSON data")
	}
	return v, nil
}

type deadlineWriter struct {
	w            http.ResponseWriter
	seconds      int
	count, limit int64
}

func (w *deadlineWriter) Write(b []byte) (int, error) {
	if w.count+int64(len(b)) > w.limit {
		return 0, errors.New("output byte limit")
	}
	c := http.NewResponseController(w.w)
	_ = c.SetWriteDeadline(time.Now().Add(time.Duration(w.seconds) * time.Second))
	n, e := w.w.Write(b)
	w.count += int64(n)
	if e == nil {
		e = c.Flush()
	}
	return n, e
}
func streamSSE(dst *deadlineWriter, src io.Reader, e entry, capBytes int, u *usage, reserved int64) error {
	return streamSSEBudget(dst, src, e, capBytes, u, reserved, nil)
}

func streamSSEBudget(dst *deadlineWriter, src io.Reader, e entry, capBytes int, u *usage, reserved int64, budget func(int64) bool) error {
	// Scanner handles CRLF and never queues events independently of the writer.
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 4096), capBytes+2)
	var frame bytes.Buffer
	var charged int64
	defer func() {
		if budget != nil {
			budget(-charged)
		}
	}()
	scanner.Split(func(data []byte, eof bool) (int, []byte, error) {
		// Reserve before Scanner grows its buffer, and before accumulating a
		// frame. Retain the high-water reservation until both buffers are freed.
		size := max(4096, len(data))
		if len(data) == cap(data) && !eof {
			size = min(capBytes+2, size*2)
		}
		need := max(int64(0), int64(frame.Len()+size)*8-(32<<10))
		if budget != nil && need > charged {
			if !budget(need - charged) {
				return 0, nil, errors.New("shared stream buffer limit")
			}
			charged = need
		}
		return splitSSELines(data, eof)
	})
	flush := func() error {
		if frame.Len() == 0 {
			return nil
		}
		raw := frame.String()
		frame.Reset()
		lines := strings.Split(strings.TrimSuffix(raw, "\n"), "\n")
		parts := []string{}
		for _, line := range lines {
			if strings.HasPrefix(line, "data:") {
				parts = append(parts, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		payload := strings.Join(parts, "\n")
		if payload == "[DONE]" {
			u.Complete = true
		}
		out := raw + "\n"
		if v, err := responseJSON([]byte(payload)); err == nil {
			observe(v, u)
			if e.Billing.Enabled {
				observeCost(v, u, e.Billing.UsageCostPointer)
			}
			if m, ok := v.(map[string]any); ok {
				if kind, _ := m["type"].(string); kind == "message_stop" || kind == "response.completed" || kind == "speech.audio.done" {
					u.Complete = true
				}
				if a, ok := m["candidates"].([]any); ok {
					for _, v := range a {
						if c, ok := v.(map[string]any); ok && c["finishReason"] != nil {
							u.Complete = true
						}
					}
				}
			}
			if e.Name != e.Actual {
				rewrite(v, e.Actual, e.Name)
				b, _ := json.Marshal(v)
				var result strings.Builder
				inserted := false
				for _, line := range lines {
					if strings.HasPrefix(line, "data:") {
						if !inserted {
							result.WriteString("data: ")
							result.Write(b)
							result.WriteByte('\n')
							inserted = true
						}
					} else {
						result.WriteString(line)
						result.WriteByte('\n')
					}
				}
				out = result.String() + "\n"
			}
		}
		if _, err := dst.Write([]byte(out)); err != nil {
			return err
		}
		if reserved > 0 && u.Found && u.Tokens > reserved {
			return errors.New("reserved output token ceiling reached")
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) == 0 {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if frame.Len()+len(line)+1 > capBytes {
			return errors.New("SSE event limit")
		}
		frame.WriteString(line)
		frame.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

// Upstream events are already size-bounded. Use the standard decoder here;
// strict duplicate-field validation remains on untrusted client requests.
func responseJSON(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing JSON data")
	}
	return v, nil
}

func splitSSELines(data []byte, atEOF bool) (int, []byte, error) {
	for i, c := range data {
		if c == '\n' {
			return i + 1, data[:i], nil
		}
		if c == '\r' {
			if i+1 == len(data) && !atEOF {
				return 0, nil, nil
			}
			n := 1
			if i+1 < len(data) && data[i+1] == '\n' {
				n++
			}
			return i + n, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}
