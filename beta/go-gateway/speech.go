package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// These are protocol families, not a catalog of versioned model IDs.
var speechVersion = regexp.MustCompile(`gemini-([0-9]+)\.([0-9]+)`)

func speechProtocol(actual string) string {
	name := strings.ToLower(actual)
	switch {
	case strings.Contains(name, "gemini"):
		if v := speechVersion.FindStringSubmatch(name); len(v) == 3 {
			major, _ := strconv.Atoi(v[1])
			minor, _ := strconv.Atoi(v[2])
			if major < 3 || major == 3 && minor < 8 {
				return "content-audio-legacy"
			}
		}
		return "content-audio"
	case strings.Contains(name, "mimo"):
		return "chat-audio"
	case strings.Contains(name, "minimax") || strings.HasPrefix(name, "speech-"):
		return "hex-audio"
	case strings.Contains(name, "qwen"):
		return "multimodal-audio"
	case strings.Contains(name, "doubao") || strings.Contains(name, "seed-tts") || strings.Contains(name, "volc"):
		return "resource-audio"
	default:
		return "standard"
	}
}
func speechRequest(path, actual string, m map[string]any) bool {
	if path == "/v1/audio/speech" {
		return true
	}
	name := strings.ToLower(actual)
	if strings.Contains(name, "tts") || strings.Contains(name, "minimax/speech") || strings.HasPrefix(name, "speech-") {
		return true
	}
	if m["audio"] != nil {
		return true
	}
	for _, key := range []string{"modalities", "responseModalities", "response_modalities"} {
		if list, ok := m[key].([]any); ok {
			for _, v := range list {
				if text, ok := v.(string); ok && strings.EqualFold(text, "audio") {
					return true
				}
			}
		}
	}
	for _, key := range []string{"generationConfig", "generation_config"} {
		if c, ok := m[key].(map[string]any); ok && speechRequest(path, "", c) {
			return true
		}
	}
	if nested, ok := m["response"].(map[string]any); ok && speechRequest(path, "", nested) {
		return true
	}
	if c, ok := m["response_format"].(map[string]any); ok && c["type"] == "audio" {
		return true
	}
	return false
}

type speechPlan struct {
	path, kind, format string
	body               map[string]any
	headers            http.Header
	events, pcm        bool
}

func planSpeech(actual string, m map[string]any) (speechPlan, error) {
	p := speechPlan{path: "/v1/audio/speech", kind: speechProtocol(actual), format: "mp3", body: m, headers: make(http.Header)}
	if value, exists := m["speech_protocol"]; exists {
		s, ok := value.(string)
		if !ok {
			return p, errors.New("invalid speech_protocol")
		}
		p.kind = s
	}
	switch p.kind {
	case "standard", "chat-audio", "content-audio", "content-audio-legacy", "hex-audio", "resource-audio", "multimodal-audio":
	default:
		return p, errors.New("unsupported speech_protocol")
	}
	text, ok := m["input"].(string)
	if !ok || strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > 4096 {
		return p, errors.New("input must contain 1..4096 characters")
	}
	if v, exists := m["response_format"]; exists {
		s, ok := v.(string)
		if !ok {
			return p, errors.New("invalid response_format")
		}
		p.format = s
	}
	switch p.format {
	case "mp3", "wav", "pcm", "opus", "aac", "flac":
	default:
		return p, errors.New("unsupported audio format")
	}
	if v, exists := m["stream_format"]; exists {
		if v != "audio" && v != "sse" {
			return p, errors.New("stream_format must be audio or sse")
		}
		p.events = v == "sse"
	}
	speed := 1.0
	if value, exists := m["speed"]; exists {
		n, ok := value.(json.Number)
		if !ok {
			return p, errors.New("invalid speed")
		}
		var err error
		speed, err = n.Float64()
		if err != nil || speed < 0.25 || speed > 4 {
			return p, errors.New("speed must be between 0.25 and 4")
		}
	}
	instruction := ""
	if v, exists := m["instructions"]; exists {
		var ok bool
		instruction, ok = v.(string)
		if !ok || utf8.RuneCountInString(instruction) > 4096 {
			return p, errors.New("invalid instructions")
		}
	}
	if p.kind == "standard" {
		delete(m, "speech_protocol")
		return p, nil
	}
	voice, ok := m["voice"].(string)
	if !ok || strings.TrimSpace(voice) == "" || len(voice) > 512 || strings.ContainsAny(voice, "\r\n") {
		return p, errors.New("voice must be a nonempty voice ID")
	}
	for key := range m {
		switch key {
		case "model", "input", "voice", "response_format", "stream_format", "speed", "instructions", "speech_protocol":
		default:
			return p, errors.New("unsupported speech option")
		}
	}
	p.body = map[string]any{"model": actual}
	switch p.kind {
	case "chat-audio":
		if speed != 1 {
			return p, errors.New("use instructions for speech speed with this protocol")
		}
		if p.format != "wav" && p.format != "pcm" && p.format != "mp3" {
			return p, errors.New("this protocol supports wav, pcm or mp3")
		}
		messages := []any{}
		if instruction != "" {
			messages = append(messages, map[string]any{"role": "user", "content": instruction})
		}
		messages = append(messages, map[string]any{"role": "assistant", "content": text})
		format := p.format
		if format == "pcm" {
			format = "pcm16"
			p.pcm = true
		}
		p.path = "/v1/chat/completions"
		p.body["messages"] = messages
		p.body["audio"] = map[string]any{"voice": voice, "format": format}
		p.body["stream"] = p.pcm
	case "content-audio", "content-audio-legacy":
		if p.format != "wav" && p.format != "pcm" {
			return p, errors.New("this protocol supports wav or pcm; choose response_format explicitly")
		}
		if speed != 1 {
			return p, errors.New("use instructions for speech speed with this protocol")
		}
		p.path = "/v1beta/models/" + actual + ":generateContent"
		part := map[string]any{"text": text}
		voiceConfig := map[string]any{"voice": voice}
		if p.kind == "content-audio-legacy" {
			voiceConfig = map[string]any{"prebuiltVoiceConfig": map[string]any{"voiceName": voice}}
			if instruction != "" {
				part["text"] = "Synthesize speech with the following style: " + instruction + "\nRead only the transcript below:\n" + text
			}
		} else if instruction != "" {
			part["speech_metadata"] = map[string]any{"style": instruction}
		}
		p.body = map[string]any{"contents": []any{map[string]any{"role": "user", "parts": []any{part}}}, "generationConfig": map[string]any{"responseModalities": []any{"AUDIO"}, "speechConfig": map[string]any{"voiceConfig": voiceConfig}}}
		p.pcm = true
	case "hex-audio":
		if instruction != "" {
			return p, errors.New("instructions are unsupported by this speech protocol")
		}
		if speed < 0.5 || speed > 2 {
			return p, errors.New("speed must be between 0.5 and 2 for this protocol")
		}
		if p.format != "mp3" && p.format != "wav" && p.format != "flac" && p.format != "pcm" {
			return p, errors.New("unsupported format for hex audio")
		}
		p.path = "/v1/t2a_v2"
		p.body["text"] = text
		p.body["voice_setting"] = map[string]any{"voice_id": voice, "speed": speed}
		p.body["audio_setting"] = map[string]any{"format": p.format, "sample_rate": 24000, "channel": 1}
		p.body["output_format"] = "hex"
		// Unary output avoids provider-specific aggregate terminal chunks.
		p.body["stream"] = false
	case "resource-audio":
		if instruction != "" {
			return p, errors.New("instructions are unsupported by this speech protocol")
		}
		if speed < 0.5 || speed > 2 {
			return p, errors.New("speed must be between 0.5 and 2 for this protocol")
		}
		format := p.format
		if format == "opus" {
			format = "ogg_opus"
		}
		if format != "mp3" && format != "pcm" && format != "ogg_opus" && format != "wav" {
			return p, errors.New("unsupported resource audio format")
		}
		p.path = "/api/v3/tts/unidirectional/sse"
		p.headers.Set("X-Api-Resource-Id", actual)
		// Build a single WAV header ourselves instead of joining repeated headers.
		if format == "wav" {
			format = "pcm"
			p.pcm = true
		}
		p.body = map[string]any{"user": map[string]any{"uid": "scrollbridge"}, "req_params": map[string]any{"text": text, "speaker": voice, "audio_params": map[string]any{"format": format, "sample_rate": 24000, "speech_rate": int((speed - 1) * 100)}}}
	case "multimodal-audio":
		p.headers.Set("X-DashScope-SSE", "enable")
		input := map[string]any{"text": text, "voice": voice}
		p.path = "/api/v1/services/aigc/multimodal-generation/generation"
		if strings.Contains(strings.ToLower(actual), "qwen-audio") {
			p.path = "/api/v1/services/audio/tts/SpeechSynthesizer"
			format := p.format
			if format == "wav" {
				format = "pcm"
				p.pcm = true
			}
			if format != "mp3" && format != "pcm" && format != "opus" {
				return p, errors.New("unsupported multimodal audio format")
			}
			if speed < 0.5 || speed > 2 {
				return p, errors.New("speed must be between 0.5 and 2 for this protocol")
			}
			input["format"] = format
			input["sample_rate"] = 24000
			input["rate"] = speed
			if instruction != "" {
				input["instruction"] = instruction
			}
		} else {
			if p.format != "wav" && p.format != "pcm" {
				return p, errors.New("this protocol supports wav or pcm; choose response_format explicitly")
			}
			if speed != 1 {
				return p, errors.New("speed unsupported by this speech protocol")
			}
			if instruction != "" {
				if !strings.Contains(strings.ToLower(actual), "instruct") {
					return p, errors.New("instructions require an instruction-capable speech model")
				}
				input["instructions"] = instruction
			}
			p.pcm = true
		}
		p.body["input"] = input
	}
	return p, nil
}

func audioType(format string) string {
	return map[string]string{"mp3": "audio/mpeg", "wav": "audio/wav", "pcm": "audio/pcm", "opus": "audio/ogg", "aac": "audio/aac", "flac": "audio/flac"}[format]
}
func waveHeader(size int, rate uint32) []byte {
	b := make([]byte, 44)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], uint32(size+36))
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 1)
	binary.LittleEndian.PutUint32(b[24:], rate)
	binary.LittleEndian.PutUint32(b[28:], rate*2)
	binary.LittleEndian.PutUint16(b[32:], 2)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], uint32(size))
	return b
}

// Binary audio bypasses JSON/SSE model rewriting and honors writer backpressure.
func (g *gateway) copyAudio(w http.ResponseWriter, src io.Reader, headers http.Header, s *snapshot) (bool, error) {
	const bufferSize = 32 << 10
	if !g.mem(bufferSize, s.cfg.Limits.MemoryBytes) {
		return false, errors.New("audio buffer budget")
	}
	defer g.mem(-bufferSize, s.cfg.Limits.MemoryBytes)
	reader, close, err := decodeReader(src, headers.Get("Content-Encoding"))
	if err != nil {
		return false, err
	}
	defer close()
	w.Header().Set("Content-Type", headers.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	dst := &deadlineWriter{w: w, seconds: s.cfg.Limits.WriteSeconds, limit: s.cfg.Limits.OutputBytes}
	_, err = io.CopyBuffer(dst, reader, make([]byte, bufferSize))
	if err == nil && dst.count == 0 {
		err = errors.New("empty audio response")
	}
	return dst.count > 0, err
}

// Read only audio-bearing protocol fields; never follow provider-returned URLs.
func speechChunks(v any, p speechPlan) ([][]byte, bool, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, false, errors.New("invalid speech response")
	}
	if m["error"] != nil {
		return nil, false, errors.New("upstream speech error")
	}
	if b, ok := m["base_resp"].(map[string]any); ok {
		if code, ok := b["status_code"].(json.Number); ok && code != "0" {
			return nil, false, errors.New("upstream speech rejected")
		}
	}
	if code, exists := m["code"]; exists && code != "" && code != json.Number("0") && code != json.Number("20000000") {
		return nil, false, errors.New("upstream speech rejected")
	}
	var chunks [][]byte
	complete := false
	decode := func(value any, hexadecimal bool) error {
		str, ok := value.(string)
		if !ok || str == "" {
			return nil
		}
		var b []byte
		var err error
		if hexadecimal {
			b, err = hex.DecodeString(str)
		} else {
			b, err = base64.StdEncoding.Strict().DecodeString(str)
		}
		if err != nil {
			return errors.New("invalid encoded audio")
		}
		chunks = append(chunks, b)
		return nil
	}
	switch p.kind {
	case "chat-audio":
		if rows, ok := m["choices"].([]any); ok {
			for _, row := range rows {
				c, _ := row.(map[string]any)
				if c["finish_reason"] != nil {
					complete = true
				}
				for _, key := range []string{"message", "delta"} {
					part, _ := c[key].(map[string]any)
					audio, _ := part["audio"].(map[string]any)
					if err := decode(audio["data"], false); err != nil {
						return nil, false, err
					}
				}
			}
		}
	case "hex-audio":
		data, _ := m["data"].(map[string]any)
		if err := decode(data["audio"], true); err != nil {
			return nil, false, err
		}
		complete = data["status"] == json.Number("2")
	case "resource-audio":
		if err := decode(m["data"], false); err != nil {
			return nil, false, err
		}
		complete = m["code"] == json.Number("20000000")
	case "multimodal-audio":
		out, _ := m["output"].(map[string]any)
		audio, _ := out["audio"].(map[string]any)
		if err := decode(audio["data"], false); err != nil {
			return nil, false, err
		}
		complete = out["finish_reason"] == "stop"
	case "content-audio", "content-audio-legacy":
		rows, _ := m["candidates"].([]any)
		for _, row := range rows {
			c, _ := row.(map[string]any)
			if reason, _ := c["finishReason"].(string); reason != "" {
				if reason != "STOP" {
					return nil, false, errors.New("speech generation did not complete")
				}
				complete = true
			}
			content, _ := c["content"].(map[string]any)
			parts, _ := content["parts"].([]any)
			for _, part := range parts {
				object, _ := part.(map[string]any)
				audio, _ := object["inlineData"].(map[string]any)
				if audio == nil {
					audio, _ = object["inline_data"].(map[string]any)
				}
				if audio == nil {
					continue
				}
				kind, _ := audio["mimeType"].(string)
				if kind == "" {
					kind, _ = audio["mime_type"].(string)
				}
				media, params, parseErr := mime.ParseMediaType(kind)
				if parseErr != nil || (media != "audio/l16" && media != "audio/pcm" && media != "audio/wav") {
					return nil, false, errors.New("unexpected audio type")
				}
				if rate := params["rate"]; rate != "" && rate != "24000" {
					return nil, false, errors.New("unsupported audio sample rate")
				}
				if p.format == "pcm" && strings.Contains(kind, "wav") {
					return nil, false, errors.New("unexpected WAV for PCM request")
				}
				if err := decode(audio["data"], false); err != nil {
					return nil, false, err
				}
			}
		}
	}
	return chunks, complete, nil
}

func (g *gateway) serveSpeech(ctx context.Context, s *snapshot, supply Upstream, w http.ResponseWriter, m map[string]any, e entry, u *usage) (code int, started bool, err error) {
	p, err := planSpeech(e.Actual, m)
	if err != nil {
		return 400, false, err
	}
	payload, err := json.Marshal(p.body)
	if err != nil {
		return 400, false, errors.New("invalid speech body")
	}
	target, _ := url.Parse(supply.URL)
	target.Path = p.path
	req, err := http.NewRequestWithContext(ctx, "POST", target.String(), bytes.NewReader(payload))
	if err != nil {
		return 502, false, errors.New("invalid speech request")
	}
	req.Header = p.headers
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	supplyCredentials(req, supply)
	response, err := g.transport.RoundTrip(req)
	if err != nil {
		return 502, false, errors.New("local speech service unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		if response.StatusCode == 404 || response.StatusCode == 405 {
			return 501, false, errors.New("local proxy does not provide the selected speech protocol")
		}
		return response.StatusCode, false, errors.New("local speech service rejected the request")
	}
	ct, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if p.kind == "standard" {
		if strings.HasPrefix(ct, "audio/") || ct == "application/octet-stream" {
			started, err = g.copyAudio(w, response.Body, response.Header, s)
			if err != nil {
				return 502, started, err
			}
			return 200, started, nil
		}
		if ct == "text/event-stream" && p.events {
			const base = 32 << 10
			if !g.mem(base, s.cfg.Limits.MemoryBytes) {
				return 503, false, errors.New("speech event buffer budget")
			}
			defer g.mem(-base, s.cfg.Limits.MemoryBytes)
			reader, close, decodeErr := decodeReader(response.Body, response.Header.Get("Content-Encoding"))
			if decodeErr != nil {
				return 502, false, errors.New("invalid speech event encoding")
			}
			defer close()
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Accel-Buffering", "no")
			dst := &deadlineWriter{w: w, seconds: s.cfg.Limits.WriteSeconds, limit: s.cfg.Limits.OutputBytes}
			err = streamSSEBudget(dst, reader, e, s.cfg.Limits.EventBytes, u, 0, func(n int64) bool { return g.mem(n, s.cfg.Limits.MemoryBytes) })
			if err != nil || !u.Complete || dst.count == 0 {
				return 502, dst.count > 0, errors.New("speech event stream did not complete")
			}
			return 200, true, nil
		}
		return 502, false, errors.New("expected audio from local speech service")
	}
	reader, close, err := decodeReader(response.Body, response.Header.Get("Content-Encoding"))
	if err != nil {
		return 502, false, errors.New("invalid speech response encoding")
	}
	defer close()
	budget := int64(s.cfg.Limits.EventBytes) * 6
	if !g.mem(budget, s.cfg.Limits.MemoryBytes) {
		return 503, false, errors.New("speech buffer budget")
	}
	defer g.mem(-budget, s.cfg.Limits.MemoryBytes)
	dst := &deadlineWriter{w: w, seconds: s.cfg.Limits.WriteSeconds, limit: s.cfg.Limits.OutputBytes}
	var collected bytes.Buffer
	var charged int64
	defer func() { g.mem(-charged, s.cfg.Limits.MemoryBytes) }()
	total := 0
	complete := false
	write := func(b []byte) error {
		if len(b) == 0 {
			return nil
		}
		total += len(b)
		if int64(total) > s.cfg.Limits.OutputBytes {
			return errors.New("audio output limit")
		}
		if p.format == "wav" && p.pcm {
			if int64(total) > s.cfg.Limits.ResponseBytes {
				return errors.New("WAV response limit")
			}
			need := int64(total) * 6
			if !g.mem(need-charged, s.cfg.Limits.MemoryBytes) {
				return errors.New("WAV buffer budget")
			}
			charged = need
			collected.Write(b)
			return nil
		}
		if !started {
			kind := audioType(p.format)
			if p.events {
				kind = "text/event-stream"
			}
			w.Header().Set("Content-Type", kind)
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Accel-Buffering", "no")
			started = true
		}
		if p.events {
			value, _ := json.Marshal(map[string]any{"type": "speech.audio.delta", "audio": base64.StdEncoding.EncodeToString(b)})
			b = append(append([]byte("data: "), value...), []byte("\n\n")...)
		}
		_, err := dst.Write(b)
		return err
	}
	consume := func(data []byte) error {
		if bytes.Equal(bytes.TrimSpace(data), []byte("[DONE]")) {
			complete = true
			return nil
		}
		v, err := responseJSON(data)
		if err != nil {
			return errors.New("invalid speech JSON")
		}
		observe(v, u)
		if e.Billing.Enabled {
			observeCost(v, u, e.Billing.UsageCostPointer)
		}
		chunks, done, err := speechChunks(v, p)
		if err != nil {
			return err
		}
		complete = complete || done
		for _, b := range chunks {
			if err := write(b); err != nil {
				return err
			}
		}
		return nil
	}
	if ct == "text/event-stream" {
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), s.cfg.Limits.EventBytes+2)
		var frame bytes.Buffer
		flush := func() error {
			if frame.Len() == 0 {
				return nil
			}
			err := consume(frame.Bytes())
			frame.Reset()
			return err
		}
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if err = flush(); err != nil {
					break
				}
				continue
			}
			if strings.HasPrefix(line, "data:") {
				part := strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")
				if frame.Len()+len(part)+1 > s.cfg.Limits.EventBytes {
					err = errors.New("speech event limit")
					break
				}
				if frame.Len() > 0 {
					frame.WriteByte('\n')
				}
				frame.WriteString(part)
			}
		}
		if err == nil {
			err = scanner.Err()
		}
		if err == nil {
			err = flush()
		}
	} else if ct == "application/json" {
		b, free, readErr := g.read(reader, s.cfg.Limits.ResponseBytes, s.cfg.Limits.MemoryBytes)
		if readErr != nil {
			return 502, started, errors.New("speech response limit")
		}
		defer free()
		// Unary conversion needs workspace for decoded JSON and encoded audio.
		extra := int64(len(b)) * 3
		if !g.mem(extra, s.cfg.Limits.MemoryBytes) {
			return 503, started, errors.New("speech conversion budget")
		}
		defer g.mem(-extra, s.cfg.Limits.MemoryBytes)
		err = consume(b)
	} else {
		err = errors.New("unexpected speech response type")
	}
	if err != nil {
		return 502, started, err
	}
	if total == 0 {
		return 502, started, errors.New("no audio returned; URL-only speech responses are not fetched")
	}
	if !complete {
		return 502, started, errors.New("speech stream ended without a completion event")
	}
	if p.format == "pcm" && total%2 != 0 {
		return 502, started, errors.New("incomplete PCM sample")
	}
	if collected.Len() > 0 {
		b := collected.Bytes()
		if !bytes.HasPrefix(b, []byte("RIFF")) {
			if len(b)%2 != 0 {
				return 502, false, errors.New("incomplete PCM sample")
			}
			header := waveHeader(len(b), 24000)
			w.Header().Set("Content-Type", "audio/wav")
			if p.events {
				w.Header().Set("Content-Type", "text/event-stream")
			}
			w.Header().Set("Cache-Control", "no-store")
			started = true
			if p.events {
				all := append(header, b...)
				data, _ := json.Marshal(map[string]any{"type": "speech.audio.delta", "audio": base64.StdEncoding.EncodeToString(all)})
				_, err = dst.Write(append(append([]byte("data: "), data...), []byte("\n\n")...))
			} else {
				_, err = dst.Write(header)
				if err == nil {
					_, err = dst.Write(b)
				}
			}
		} else {
			p.pcm = false
			total -= len(b)
			err = write(b)
		}
		if err != nil {
			return 502, started, err
		}
	}
	if p.events {
		_, err = dst.Write([]byte("data: {\"type\":\"speech.audio.done\"}\n\n"))
		if err != nil {
			return 502, started, err
		}
	}
	u.Complete = true
	return 200, started, nil
}
