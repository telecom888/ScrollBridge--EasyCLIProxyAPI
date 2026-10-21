package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/gofrs/flock"
)

// Reservations are charged before dispatch and refunds are durable before reuse.
// A crash therefore overcharges incomplete calls rather than making credit reusable.
type accounting interface {
	Reserve(string, int64, int64) error
	Refund(string, int64) error
	Close() error
}
type journalRow struct {
	Key   string `json:"key"`
	Delta int64  `json:"delta"`
}
type ledger struct {
	mu       sync.Mutex
	used     map[string]int64
	f        *os.File
	lock     *flock.Flock
	poisoned bool
}

func openLedger(dir string) (*ledger, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	l := &ledger{used: map[string]int64{}, lock: flock.New(filepath.Join(dir, "quota.lock"))}
	ok, err := l.lock.TryLock()
	if err != nil || !ok {
		return nil, errors.New("quota directory already locked or inaccessible")
	}
	fail := func(e error) (*ledger, error) { l.lock.Unlock(); return nil, e }
	path := filepath.Join(dir, "quota.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return fail(err)
	}
	l.f = f
	r := bufio.NewReader(f)
	for {
		line, e := r.ReadSlice('\n')
		if len(line) > 0 {
			var row journalRow
			if len(line) > 4096 || line[len(line)-1] != '\n' || json.Unmarshal(line, &row) != nil || !validID.MatchString(row.Key) || row.Delta > 1<<50 || row.Delta < -(1<<50) || l.used[row.Key]+row.Delta < 0 {
				f.Close()
				return fail(errors.New("invalid or torn quota journal; restore audited backup before startup"))
			}
			l.used[row.Key] += row.Delta
		}
		if e != nil {
			if e != io.EOF {
				f.Close()
				return fail(e)
			}
			break
		}
	}
	return l, nil
}
func (l *ledger) change(key string, delta int64) error {
	if l.poisoned {
		return errors.New("quota storage unavailable")
	}
	b, _ := json.Marshal(journalRow{key, delta})
	b = append(b, '\n')
	n, err := l.f.Write(b)
	if err == nil && n != len(b) {
		err = errors.New("short quota write")
	}
	if err == nil {
		err = l.f.Sync()
	}
	if err != nil {
		l.poisoned = true
		return errors.New("quota storage unavailable")
	}
	l.used[key] += delta
	return nil
}
func (l *ledger) Reserve(key string, n, limit int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n <= 0 || l.used[key] > limit-n {
		return fmt.Errorf("output token quota exhausted")
	}
	return l.change(key, n)
}
func (l *ledger) Refund(key string, n int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n < 0 || n > l.used[key] {
		return errors.New("invalid quota refund")
	}
	if n == 0 {
		return nil
	}
	return l.change(key, -n)
}
func (l *ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.f.Close()
	l.lock.Unlock()
	return e
}
