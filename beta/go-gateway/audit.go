package main

import (
	"encoding/json"
	"errors"
	"github.com/gofrs/flock"
	"os"
	"path/filepath"
	"sync"
)

// Node-local reported-cost audit. This is not a wallet or invoicing database.
type audit struct {
	mu       sync.Mutex
	f        *os.File
	lock     *flock.Flock
	poisoned bool
}

func openAudit(dir string) (*audit, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	l := flock.New(filepath.Join(dir, "audit.lock"))
	ok, e := l.TryLock()
	if e != nil || !ok {
		return nil, errors.New("audit directory already owned or inaccessible")
	}
	f, e := os.OpenFile(filepath.Join(dir, "billing.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if e != nil {
		l.Unlock()
		return nil, e
	}
	return &audit{f: f, lock: l}, nil
}
func (a *audit) append(v any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.poisoned {
		return errors.New("audit unavailable")
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	b = append(b, '\n')
	n, e := a.f.Write(b)
	if e == nil && n != len(b) {
		e = errors.New("short audit write")
	}
	if e == nil {
		e = a.f.Sync()
	}
	if e != nil {
		a.poisoned = true
	}
	return e
}
func (a *audit) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	e := a.f.Close()
	a.lock.Unlock()
	return e
}
