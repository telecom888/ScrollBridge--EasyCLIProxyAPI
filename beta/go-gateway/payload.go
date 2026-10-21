package main

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"encoding/json"
	"errors"
	"github.com/andybalholm/brotli"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"
)

type upload struct {
	Name, Filename, Mime string
	Data                 []byte
}

func decodeReader(src io.Reader, encoding string) (io.Reader, func(), error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return src, func() {}, nil
	case "gzip":
		r, e := gzip.NewReader(src)
		if e != nil {
			return nil, func() {}, e
		}
		return r, func() { r.Close() }, nil
	case "deflate":
		r, e := zlib.NewReader(src)
		if e != nil {
			return nil, func() {}, e
		}
		return r, func() { r.Close() }, nil
	case "br":
		return brotli.NewReader(src), func() {}, nil
	default:
		return nil, func() {}, errors.New("unsupported content encoding")
	}
}
func parseMultipart(b []byte, ct string) (map[string]any, []upload, error) {
	_, p, e := mime.ParseMediaType(ct)
	if e != nil || p["boundary"] == "" {
		return nil, nil, errors.New("invalid multipart boundary")
	}
	r := multipart.NewReader(bytes.NewReader(b), p["boundary"])
	m := map[string]any{}
	files := []upload{}
	fields := 0
	for count := 0; ; count++ {
		part, e := r.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil || count >= 160 {
			return nil, nil, errors.New("invalid multipart parts")
		}
		_, d, e := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if e != nil || d["name"] == "" {
			return nil, nil, errors.New("invalid part name")
		}
		name := d["name"]
		body, e := io.ReadAll(io.LimitReader(part, (32<<20)+1))
		part.Close()
		if e != nil || len(body) > 32<<20 {
			return nil, nil, errors.New("multipart part limit")
		}
		if _, file := d["filename"]; file {
			if name == "model" || len(files) >= 32 {
				return nil, nil, errors.New("invalid file selector")
			}
			mt, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
			files = append(files, upload{name, d["filename"], mt, body})
		} else {
			if _, duplicate := m[name]; duplicate || fields >= 128 {
				return nil, nil, errors.New("duplicate multipart field")
			}
			fields++
			m[name] = string(body)
		}
	}
	return m, files, nil
}
func encodeMultipart(m map[string]any, files []upload) ([]byte, string, error) {
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	for name, v := range m {
		s, ok := v.(string)
		if !ok {
			raw, e := json.Marshal(v)
			if e != nil {
				return nil, "", e
			}
			s = string(raw)
		}
		if e := w.WriteField(name, s); e != nil {
			return nil, "", e
		}
	}
	clean := func(s string) string {
		return strings.NewReplacer("\r", "_", "\n", "_", "\"", "_", "\\", "_").Replace(s)
	}
	for _, f := range files {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", `form-data; name="`+clean(f.Name)+`"; filename="`+clean(f.Filename)+`"`)
		h.Set("Content-Type", f.Mime)
		part, e := w.CreatePart(h)
		if e != nil {
			return nil, "", e
		}
		if _, e = part.Write(f.Data); e != nil {
			return nil, "", e
		}
	}
	if e := w.Close(); e != nil {
		return nil, "", e
	}
	return b.Bytes(), w.FormDataContentType(), nil
}
