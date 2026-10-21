package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type Config struct {
	Version      int64      `json:"version"`
	Listen       string     `json:"listen"`
	Limits       Limits     `json:"limits"`
	Images       bool       `json:"images"`
	GeminiImages bool       `json:"geminiImageCompatibility"`
	Billing      Billing    `json:"billing"`
	Keys         []Key      `json:"keys"`
	Models       []Model    `json:"models"`
	Upstreams    []Upstream `json:"upstreams"`
}
type Limits struct {
	Concurrent     int   `json:"concurrent"`
	BodyBytes      int64 `json:"bodyBytes"`
	MemoryBytes    int64 `json:"memoryBytes"`
	EventBytes     int   `json:"eventBytes"`
	ResponseBytes  int64 `json:"responseBytes"`
	OutputBytes    int64 `json:"outputBytes"`
	RequestSeconds int   `json:"requestSeconds"`
	WriteSeconds   int   `json:"writeSeconds"`
}
type Key struct {
	ID              string   `json:"id"`
	Digest          string   `json:"sha256"`
	Enabled         bool     `json:"enabled"`
	Mode            string   `json:"mode"`
	Allowed         []string `json:"allowed"`
	Concurrent      int      `json:"concurrent"`
	OutputTokens    int64    `json:"outputTokens"`
	MaxOutputTokens int64    `json:"maxOutputTokens"`
}
type Model struct {
	ID           string            `json:"id"`
	Actual       string            `json:"actual"`
	Aliases      []string          `json:"aliases"`
	ExposureIDs  map[string]string `json:"exposureIds,omitempty"`
	KeepOriginal bool              `json:"keepOriginal"`
	Enabled      bool              `json:"enabled"`
	Available    *bool             `json:"available,omitempty"`
	Rates        *Rates            `json:"rates,omitempty"`
}
type Upstream struct {
	ID     string `json:"id"`
	URL    string `json:"url"`
	KeyEnv string `json:"keyEnv"`
	Auth   string `json:"auth,omitempty"`
}
type entry struct {
	Name, Actual, ID string
	Enabled          bool
	Available        bool
	Billing          Billing
}
type snapshot struct {
	cfg             Config
	keys            map[[32]byte]*Key
	byID            map[string]*Key
	names           map[string]entry
	grants          map[string]map[string]bool
	ordered         []entry
	accessSignature string
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)
var validActual = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$`)

func normalized(s string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "models/"))
}
func decodeConfig(b []byte) (*snapshot, error) {
	if len(b) > 4<<20 {
		return nil, errors.New("configuration exceeds 4 MiB")
	}
	var c Config
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return nil, err
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing configuration data")
	}
	return compile(c)
}
func compile(c Config) (*snapshot, error) {
	if c.Version < 1 || c.Version > 1<<50 {
		return nil, errors.New("version must be positive")
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:18453"
	}
	host, port, err := net.SplitHostPort(c.Listen)
	listenPort, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || listenPort < 1024 || listenPort > 65535 || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return nil, errors.New("listen must be a literal loopback address")
	}
	l := &c.Limits
	if l.Concurrent == 0 {
		l.Concurrent = 64
	}
	if l.BodyBytes == 0 {
		l.BodyBytes = 32 << 20
	}
	if l.MemoryBytes == 0 {
		l.MemoryBytes = 256 << 20
	}
	if l.EventBytes == 0 {
		l.EventBytes = 256 << 10
	}
	if l.ResponseBytes == 0 {
		l.ResponseBytes = 64 << 20
	}
	if l.OutputBytes == 0 {
		l.OutputBytes = 64 << 20
	}
	if l.RequestSeconds == 0 {
		l.RequestSeconds = 600
	}
	if l.WriteSeconds == 0 {
		l.WriteSeconds = 30
	}
	if l.Concurrent < 1 || l.Concurrent > 4096 || l.BodyBytes < 1 || l.BodyBytes > 32<<20 || l.MemoryBytes < l.BodyBytes || l.MemoryBytes > 2<<30 || l.EventBytes < 128 || l.EventBytes > 4<<20 || l.ResponseBytes < 128 || l.ResponseBytes > 64<<20 || l.OutputBytes < 128 || l.OutputBytes > 1<<30 || l.RequestSeconds < 1 || l.RequestSeconds > 1800 || l.WriteSeconds < 1 || l.WriteSeconds > 120 {
		return nil, errors.New("invalid resource limits")
	}
	if len(c.Keys) > 1000 || len(c.Models) > 10000 || len(c.Upstreams) == 0 || len(c.Upstreams) > 64 {
		return nil, errors.New("invalid configuration size")
	}
	s := &snapshot{cfg: c, keys: map[[32]byte]*Key{}, byID: map[string]*Key{}, names: map[string]entry{}, grants: map[string]map[string]bool{}}
	if err := validateBilling(&s.cfg.Billing); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	actuals := map[string]bool{}
	exposureIDs := map[string]bool{}
	for _, m := range c.Models {
		if m.Rates != nil {
			b := s.cfg.Billing
			b.Rates = *m.Rates
			if err := validateBilling(&b); err != nil {
				return nil, err
			}
		}
		if !validID.MatchString(m.ID) || ids[m.ID] || !validActual.MatchString(m.Actual) || actuals[normalized(m.Actual)] || len(m.Aliases) > 1000 {
			return nil, errors.New("invalid or duplicate model")
		}
		ids[m.ID] = true
		actuals[normalized(m.Actual)] = true
	}
	for _, m := range c.Models {
		for _, a := range m.Aliases {
			if normalized(a) == normalized(m.Actual) {
				return nil, errors.New("alias collides with original model ID")
			}
		}
		all := append([]string{m.Actual}, m.Aliases...)
		validNames := map[string]bool{}
		for _, name := range all {
			validNames[name] = true
			id := m.ExposureIDs[name]
			if id == "" {
				id = normalized(name)
			}
			if !validID.MatchString(id) || exposureIDs[id] {
				return nil, errors.New("duplicate or invalid exposure ID")
			}
			exposureIDs[id] = true
		}
		for name := range m.ExposureIDs {
			if !validNames[name] {
				return nil, errors.New("exposure ID refers to unknown model name")
			}
		}
		names := append([]string{}, m.Aliases...)
		if m.KeepOriginal || len(names) == 0 {
			names = append([]string{m.Actual}, names...)
		}
		for _, name := range names {
			n := normalized(name)
			if (!validID.MatchString(name) && name != m.Actual) || s.names[n].Name != "" || (actuals[n] && n != normalized(m.Actual)) {
				return nil, errors.New("invalid or colliding exposure")
			}
			billing := s.cfg.Billing
			if m.Rates != nil {
				billing.Rates = *m.Rates
			}
			id := m.ExposureIDs[name]
			if id == "" {
				id = n
			}
			available := m.Available == nil || *m.Available
			s.names[n] = entry{Name: name, Actual: m.Actual, ID: id, Enabled: m.Enabled, Available: available, Billing: billing}
			s.ordered = append(s.ordered, s.names[n])
		}
	}
	for i := range s.cfg.Keys {
		k := &s.cfg.Keys[i]
		b, e := hex.DecodeString(k.Digest)
		if e != nil || len(b) != 32 || !validID.MatchString(k.ID) || s.byID[k.ID] != nil || k.Concurrent < 0 || k.Concurrent > l.Concurrent || k.OutputTokens < 0 || k.OutputTokens > 1<<50 || k.MaxOutputTokens < 0 || k.MaxOutputTokens > 1<<30 || (k.Mode != "all" && k.Mode != "selected") || (k.OutputTokens > 0 && k.MaxOutputTokens == 0) {
			return nil, errors.New("invalid key metadata")
		}
		var digest [32]byte
		copy(digest[:], b)
		if s.keys[digest] != nil {
			return nil, errors.New("duplicate consumer digest")
		}
		s.keys[digest] = k
		s.byID[k.ID] = k
		g := map[string]bool{}
		for _, id := range k.Allowed {
			if !exposureIDs[id] || g[id] {
				return nil, errors.New("unknown or duplicate grant")
			}
			g[id] = true
		}
		s.grants[k.ID] = g
	}
	upstreams := map[string]bool{}
	for _, u := range c.Upstreams {
		if u.Auth != "" && u.Auth != "auto" && u.Auth != "bearer" {
			return nil, errors.New("invalid upstream authentication mode")
		}
		p, e := url.Parse(u.URL)
		if e != nil || !validID.MatchString(u.ID) || upstreams[u.ID] || p.User != nil || p.RawQuery != "" || p.Fragment != "" || (p.Path != "" && p.Path != "/") || p.Hostname() == "" || (p.Scheme != "http" && p.Scheme != "https") {
			return nil, errors.New("invalid upstream")
		}
		// Cleartext upstreams are confined to this computer. Remote supply requires TLS.
		ip := net.ParseIP(p.Hostname())
		if ip != nil && ip.IsLoopback() && p.Port() == port {
			return nil, errors.New("upstream cannot point at gateway listener")
		}
		if p.Scheme == "http" && (ip == nil || !ip.IsLoopback()) {
			return nil, errors.New("remote upstream requires HTTPS")
		}
		if u.KeyEnv != "" && os.Getenv(u.KeyEnv) == "" {
			return nil, fmt.Errorf("missing credential environment variable for upstream %s", u.ID)
		}
		upstreams[u.ID] = true
	}
	access := s.cfg
	access.Version = 0
	access.Billing = Billing{}
	access.Models = append([]Model(nil), s.cfg.Models...)
	for i := range access.Models {
		access.Models[i].Rates = nil
	}
	encoded, _ := json.Marshal(access)
	s.accessSignature = string(encoded)
	return s, nil
}
func (s *snapshot) auth(token string) *Key {
	if token == "" || len(token) > 512 {
		return nil
	}
	k := s.keys[sha256.Sum256([]byte(token))]
	if k == nil || !k.Enabled {
		return nil
	}
	return k
}
func (s *snapshot) resolve(k *Key, name string) (entry, int) {
	e, ok := s.names[normalized(name)]
	if !ok || !e.Available {
		return e, 404
	}
	if !e.Enabled || (k.Mode == "selected" && !s.grants[k.ID][e.ID]) {
		return e, 403
	}
	return e, 0
}
