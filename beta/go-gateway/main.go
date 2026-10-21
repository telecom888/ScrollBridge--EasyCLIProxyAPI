package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"time"
)

func readConfigFile(r io.Reader) ([]byte, error) {
	b, e := io.ReadAll(io.LimitReader(r, (4<<20)+1))
	if e != nil || len(b) > 4<<20 {
		return nil, fmt.Errorf("configuration exceeds limit or cannot be read")
	}
	return b, nil
}

func watch(ctx context.Context, g *gateway, load func(context.Context) (*snapshot, error), wake <-chan *struct{}) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-wake:
		}
		check, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		s, err := load(check)
		cancel()
		if err == nil {
			old := g.current.Load()
			if s.cfg.Version > old.cfg.Version {
				err = g.apply(s)
			} else if s.cfg.Version < old.cfg.Version {
				err = fmt.Errorf("configuration rollback rejected")
			} else {
				a, _ := json.Marshal(old.cfg)
				b, _ := json.Marshal(s.cfg)
				if string(a) != string(b) {
					err = fmt.Errorf("configuration changed without version increment")
				}
			}
		}
		if err == nil {
			last = time.Now()
			if g.stale.Swap(false) {
				slog.Info("configuration source recovered")
			}
		} else if time.Since(last) > 5*time.Second && !g.stale.Swap(true) {
			g.mu.Lock()
			for f := range g.active {
				f.cancel()
			}
			g.mu.Unlock()
			slog.Error("configuration source stale; traffic blocked")
		}
	}
}
func main() {
	if err := run(); err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
}
func run() error {
	config := flag.String("config", "config.beta.json", "configuration file (no plaintext keys)")
	state := flag.String("state", ".beta-state", "private durable quota directory")
	redisEnv := flag.String("redis-env", "", "environment variable containing Redis URL; shared config and quotas")
	publish := flag.Bool("publish", false, "validate and publish config to Redis, then exit")
	check := flag.Bool("check", false, "validate configuration and exit")
	keygen := flag.Bool("keygen", false, "print one new consumer key and its SHA-256; intentionally visible once")
	admin := flag.String("admin", "", "optional separate loopback metrics listener; requires SCROLLBRIDGE_ADMIN_KEY")
	desktop := flag.Bool("desktop", false, "private stdin/stdout control owned by Electron")
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	if *desktop {
		return runDesktop(*state)
	}
	if *keygen {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		key := "sb_" + base64.RawURLEncoding.EncodeToString(b)
		sum := sha256.Sum256([]byte(key))
		fmt.Printf("Key: %s\nSHA256: %s\n", key, hex.EncodeToString(sum[:]))
		return nil
	}
	readFile := func(context.Context) (*snapshot, error) {
		f, e := os.Open(*config)
		if e != nil {
			return nil, fmt.Errorf("configuration file unavailable")
		}
		defer f.Close()
		b, e := readConfigFile(f)
		if e != nil {
			return nil, e
		}
		return decodeConfig(b)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var s *snapshot
	var err error
	var redisStore *redisState
	var ledgerStore accounting
	var load = readFile
	var wakes <-chan *struct{}
	if *redisEnv != "" {
		raw := os.Getenv(*redisEnv)
		if raw == "" {
			return fmt.Errorf("Redis environment variable is empty")
		}
		redisStore, err = newRedis(raw)
		if err != nil {
			return err
		}
		defer redisStore.Close()
		if *publish {
			b, e := os.ReadFile(*config)
			if e != nil {
				return fmt.Errorf("configuration file unavailable")
			}
			s, e = decodeConfig(b)
			if e != nil {
				return e
			}
			return redisStore.publish(ctx, s, b)
		}
		load = redisStore.load
		ledgerStore = redisStore
	} else if *publish {
		return fmt.Errorf("publish requires -redis-env")
	}
	s, err = load(ctx)
	if err != nil {
		return err
	}
	if *check {
		slog.Info("configuration valid", "version", s.cfg.Version)
		return nil
	}
	if ledgerStore == nil {
		ledgerStore, err = openLedger(*state)
		if err != nil {
			return err
		}
		defer ledgerStore.Close()
	}
	g := newGateway(s, ledgerStore)
	auditStore, err := openAudit(*state)
	if err != nil {
		return err
	}
	defer auditStore.Close()
	g.audit = auditStore
	if redisStore != nil {
		sub := redisStore.client.Subscribe(ctx, redisChannel)
		defer sub.Close()
		ch := make(chan *struct{}, 1)
		wakes = ch
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case _, ok := <-sub.Channel():
					if !ok {
						return
					}
					select {
					case ch <- &struct{}{}:
					default:
					}
				}
			}
		}()
	}
	var adminServer *http.Server
	if *admin != "" {
		host, _, e := net.SplitHostPort(*admin)
		ip := net.ParseIP(host)
		secret := os.Getenv("SCROLLBRIDGE_ADMIN_KEY")
		if e != nil || ip == nil || !ip.IsLoopback() || len(secret) < 32 {
			return fmt.Errorf("admin requires loopback and a 32+ character SCROLLBRIDGE_ADMIN_KEY")
		}
		digest := sha256.Sum256([]byte(secret))
		adminServer = &http.Server{Addr: *admin, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, IdleTimeout: 10 * time.Second, WriteTimeout: 5 * time.Second, MaxHeaderBytes: 4096, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			candidate := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
			if subtle.ConstantTimeCompare(candidate[:], digest[:]) != 1 {
				problem(w, 401, "invalid admin key")
				return
			}
			if r.Method != "GET" || r.URL.Path != "/metrics" {
				problem(w, 404, "not found")
				return
			}
			v := g.metrics()
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			v["heap_bytes"] = m.HeapAlloc
			v["goroutines"] = runtime.NumGoroutine()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(v)
		})}
		listener, e := net.Listen("tcp", *admin)
		if e != nil {
			return fmt.Errorf("admin listener unavailable")
		}
		go adminServer.Serve(limitConnections(listener, 16))
		defer adminServer.Close()
	}
	server := serverFor(g)
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return fmt.Errorf("gateway listener unavailable")
	}
	go watch(ctx, g, load, wakes)
	errors := make(chan error, 1)
	go func() { errors <- server.Serve(limitConnections(listener, max(128, s.cfg.Limits.Concurrent*4))) }()
	slog.Info("Go gateway beta ready", "listen", server.Addr, "version", s.cfg.Version)
	select {
	case <-ctx.Done():
	case err = <-errors:
		if err != http.ErrServerClosed {
			return err
		}
	}
	g.stale.Store(true)
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err = server.Shutdown(shutdown)
	if err != nil {
		server.Close()
	}
	g.transport.CloseIdleConnections()
	return nil
}
