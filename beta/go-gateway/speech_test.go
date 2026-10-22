package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func enableSpeech(t *testing.T, g *gateway, actual string) {
	t.Helper()
	c := g.current.Load().cfg
	c.Version++
	c.Speech = true
	c.Models = append([]Model(nil), c.Models...)
	c.Models[0].Actual = actual
	c.Models[0].ExposureIDs = map[string]string{actual: "original", "chat-alias": "chat-alias", "second-alias": "second-alias"}
	s, err := compile(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.apply(s); err != nil {
		t.Fatal(err)
	}
}
func speechBody(format string) string {
	return fmt.Sprintf(`{"model":"chat-alias","input":"hello","voice":"voice-demo","response_format":%q}`, format)
}
func TestSpeechProtocolsAndAliases(t *testing.T) {
	pcm := []byte{0, 1, 2, 3}
	encoded := base64.StdEncoding.EncodeToString(pcm)
	for _, actual := range []string{"custom-voice-v9", "Vendor/MiMo-TTS-Next", "Vendor/Gemini-Future-TTS", "MiniMax/speech-next", "seed-tts-future", "qwen3-tts-next", "qwen-audio-next-tts"} {
		t.Run(actual, func(t *testing.T) {
			g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				var m map[string]any
				if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
					t.Error(err)
				}
				if strings.Contains(r.Header.Get("Authorization"), testToken) {
					t.Error("consumer credential forwarded")
				}
				w.Header().Set("Content-Type", "application/json")
				switch speechProtocol(actual) {
				case "standard":
					if r.URL.Path != "/v1/audio/speech" || m["model"] != actual {
						t.Errorf("wrong standard route/body: %s %v", r.URL.Path, m)
					}
					w.Header().Set("Content-Type", "audio/mpeg")
					w.Write([]byte("mp3-test"))
				case "chat-audio":
					if r.URL.Path != "/v1/chat/completions" {
						t.Error(r.URL.Path)
					}
					messages, _ := m["messages"].([]any)
					last, _ := messages[len(messages)-1].(map[string]any)
					if last["role"] != "assistant" || last["content"] != "hello" {
						t.Error(messages)
					}
					fmt.Fprintf(w, `{"choices":[{"finish_reason":"stop","message":{"audio":{"data":%q}}}]}`, encoded)
				case "content-audio":
					if r.URL.Path != "/v1beta/models/"+actual+":generateContent" {
						t.Error(r.URL.Path)
					}
					fmt.Fprintf(w, `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"inlineData":{"mimeType":"audio/L16;codec=pcm;rate=24000","data":%q}}]}}]}`, encoded)
				case "hex-audio":
					if r.URL.Path != "/v1/t2a_v2" || m["output_format"] != "hex" {
						t.Error(m)
					}
					io.WriteString(w, `{"base_resp":{"status_code":0},"data":{"status":2,"audio":"00010203"}}`)
				case "resource-audio":
					if r.URL.Path != "/api/v3/tts/unidirectional/sse" || r.Header.Get("X-Api-Resource-Id") != actual {
						t.Error(r.URL.Path)
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprintf(w, "data: {\"code\":0,\"data\":%q}\n\ndata: {\"code\":20000000}\n\n", encoded)
				case "multimodal-audio":
					if !strings.HasPrefix(r.URL.Path, "/api/v1/services/") || r.Header.Get("X-DashScope-SSE") != "enable" {
						t.Error(r.URL.Path)
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprintf(w, "data: {\"output\":{\"audio\":{\"data\":%q}}}\n\ndata: {\"output\":{\"finish_reason\":\"stop\"}}\n\n", encoded)
				}
			})
			enableSpeech(t, g, actual)
			format := "pcm"
			if speechProtocol(actual) == "standard" {
				format = "mp3"
			}
			status, body := call(t, server, "/v1/audio/speech", speechBody(format))
			if status != 200 {
				t.Fatalf("%d %s", status, body)
			}
			expected := pcm
			if format == "mp3" {
				expected = []byte("mp3-test")
			}
			if !bytes.Equal(body, expected) {
				t.Fatalf("audio corrupted: %x", body)
			}
			// The global gate and key policy are evaluated before reaching the adapter.
			c := g.current.Load().cfg
			c.Version++
			c.Models = append([]Model(nil), c.Models...)
			c.Models[0].Enabled = false
			s, _ := compile(c)
			g.apply(s)
			if code, _ := call(t, server, "/v1/audio/speech", speechBody(format)); code != 403 {
				t.Fatal(code)
			}
		})
	}
}
func TestSpeechDisabledAndProtocolValidation(t *testing.T) {
	var requests atomic.Int32
	g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Write([]byte("audio"))
	})
	if status, _ := call(t, server, "/v1/audio/speech", speechBody("mp3")); status != 404 {
		t.Fatal(status)
	}
	enableSpeech(t, g, "Gemini-Anything-TTS")
	for _, body := range []string{speechBody("mp3"), `{"model":"chat-alias","input":"hello","voice":"v","speech_protocol":"https://attacker.invalid"}`, `{"model":"chat-alias","input":"","voice":"v"}`} {
		if status, _ := call(t, server, "/v1/audio/speech", body); status != 400 {
			t.Fatal(status)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("invalid requests reached upstream")
	}
	c := g.current.Load().cfg
	c.Version++
	c.Speech = false
	s, _ := compile(c)
	g.apply(s)
	for _, path := range []string{"/v1/chat/completions", "/v1beta/models/chat-alias:generateContent", "/v1/responses"} {
		if code, _ := call(t, server, path, `{"model":"chat-alias","messages":[]}`); code != 404 {
			t.Fatal(path, code)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("speech switch bypassed")
	}
}
func TestSpeechWAVAndBusinessErrors(t *testing.T) {
	mode := atomic.Int32{}
	g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch mode.Load() {
		case 0:
			io.WriteString(w, `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"inlineData":{"mimeType":"audio/L16;rate=24000","data":"AAECAw=="}}]}}]}`)
		case 1:
			io.WriteString(w, `{"error":{"message":"provider error"}}`)
		case 2:
			io.WriteString(w, `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"inlineData":{"mimeType":"audio/L16;rate=240000","data":"AAECAw=="}}]}}]}`)
		case 3:
			io.WriteString(w, `{"candidates":[{"finishReason":"STOP","content":{"parts":[]}}]}`)
		}
	})
	enableSpeech(t, g, "Gemini-Next-TTS")
	code, b := call(t, server, "/v1/audio/speech", speechBody("wav"))
	if code != 200 || len(b) != 48 || string(b[:4]) != "RIFF" || binary.LittleEndian.Uint32(b[24:]) != 24000 || !bytes.Equal(b[44:], []byte{0, 1, 2, 3}) {
		t.Fatalf("invalid WAV: %d %x", code, b)
	}
	for _, n := range []int32{1, 2, 3} {
		g.pool = newPool()
		mode.Store(n)
		if code, b := call(t, server, "/v1/audio/speech", speechBody("wav")); code != 502 {
			t.Fatalf("%d %s", code, b)
		}
	}
}
func TestSpeechBinaryAndDecodedSSEAreIncremental(t *testing.T) {
	for _, actual := range []string{"custom-tts", "mimo-next-tts"} {
		t.Run(actual, func(t *testing.T) {
			release := make(chan struct{})
			var closed atomic.Bool
			t.Cleanup(func() {
				if closed.CompareAndSwap(false, true) {
					close(release)
				}
			})
			g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
				if speechProtocol(actual) == "standard" {
					w.Header().Set("Content-Type", "audio/mpeg")
					w.Write([]byte("first"))
					w.(http.Flusher).Flush()
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
					w.Write([]byte("last"))
				} else {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"AAE=\"}}}]}\n\n")
					w.(http.Flusher).Flush()
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
					io.WriteString(w, "data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{\"audio\":{\"data\":\"AgM=\"}}}]}\n\n")
				}
			})
			enableSpeech(t, g, actual)
			format := "pcm"
			first := []byte{0, 1}
			if speechProtocol(actual) == "standard" {
				format = "mp3"
				first = []byte("first")
			}
			request, _ := http.NewRequest("POST", server.URL+"/v1/audio/speech", strings.NewReader(speechBody(format)))
			request.Header.Set("Authorization", "Bearer "+testToken)
			request.Header.Set("Content-Type", "application/json")
			client := *server.Client()
			client.Timeout = 3 * time.Second
			resp, err := client.Do(request)
			if err != nil {
				t.Fatal("first chunk was buffered:", err)
			}
			defer resp.Body.Close()
			b := make([]byte, len(first))
			if _, err = io.ReadFull(resp.Body, b); err != nil || !bytes.Equal(b, first) {
				t.Fatalf("first audio: %x %v", b, err)
			}
			if closed.CompareAndSwap(false, true) {
				close(release)
			}
			if _, err = io.ReadAll(resp.Body); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestSpeechTruncation(t *testing.T) {
	g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"AAE=\"}}}]}\n\n")
		w.(http.Flusher).Flush()
	})
	enableSpeech(t, g, "mimo-future-tts")
	request, _ := http.NewRequest("POST", server.URL+"/v1/audio/speech", strings.NewReader(speechBody("pcm")))
	request.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err = io.ReadAll(resp.Body); err == nil {
		t.Fatal("truncated audio stream appeared successful")
	}
}

func TestSpeechClientCancellation(t *testing.T) {
	closed := make(chan struct{})
	g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		io.WriteString(w, "audio")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	})
	enableSpeech(t, g, "custom-voice-v9")
	r, _ := http.NewRequest("POST", server.URL+"/v1/audio/speech", strings.NewReader(speechBody("mp3")))
	r.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	first := make([]byte, 5)
	if _, err = io.ReadFull(resp.Body, first); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("speech cancellation did not reach upstream")
	}
}

func TestSpeechConvertedEvents(t *testing.T) {
	g, server, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"AAE=\"}}}]}\n\ndata: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n")
	})
	enableSpeech(t, g, "mimo-next-tts")
	body := strings.TrimSuffix(speechBody("pcm"), "}") + `,"stream_format":"sse"}`
	r, _ := http.NewRequest("POST", server.URL+"/v1/audio/speech", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != 200 || !bytes.Contains(b, []byte(`"audio":"AAE="`)) || !bytes.Contains(b, []byte("speech.audio.done")) {
		t.Fatalf("speech events: %s %v", b, err)
	}
}
func TestSpeechEnvelopeDecoders(t *testing.T) {
	for _, test := range []struct{ kind, text string }{
		{"hex-audio", `{"base_resp":{"status_code":1001},"data":{"status":2,"audio":"0001"}}`},
		{"hex-audio", `{"base_resp":{"status_code":0},"data":{"status":2,"audio":"xyz"}}`},
		{"resource-audio", `{"code":45000000,"message":"failed"}`},
		{"chat-audio", `{"choices":[{"finish_reason":"stop","message":{"audio":{"data":"bad!!!"}}}]}`},
	} {
		v, _ := responseJSON([]byte(test.text))
		if _, _, err := speechChunks(v, speechPlan{kind: test.kind}); err == nil {
			t.Fatal(test)
		}
	}
}
