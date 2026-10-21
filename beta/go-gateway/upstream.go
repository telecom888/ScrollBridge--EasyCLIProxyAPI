package main

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

type supply struct {
	active, failures int
	epoch            uint64
	until            time.Time
	probe            bool
}
type pool struct {
	mu     sync.Mutex
	states map[string]*supply
	next   uint64
}

func newPool() *pool { return &pool{states: map[string]*supply{}} }

func (p *pool) prune(list []Upstream) {
	p.mu.Lock()
	defer p.mu.Unlock()
	keep := map[string]bool{}
	for _, u := range list {
		keep[u.ID] = true
	}
	for id, s := range p.states {
		if !keep[id] && s.active == 0 {
			delete(p.states, id)
		}
	}
}
func (p *pool) pick(list []Upstream) (Upstream, func(int, http.Header, error), bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	best := -1
	load := int(^uint(0) >> 1)
	for j := 0; j < len(list); j++ {
		i := (int(p.next) + j) % len(list)
		u := list[i]
		s := p.states[u.ID]
		if s == nil {
			s = &supply{}
			p.states[u.ID] = s
		}
		if now.Before(s.until) || s.probe {
			continue
		}
		if s.active < load {
			best = i
			load = s.active
		}
	}
	if best < 0 {
		return Upstream{}, nil, false
	}
	p.next++
	u := list[best]
	s := p.states[u.ID]
	s.active++
	if s.failures > 0 {
		s.probe = true
	}
	epoch := s.epoch
	var once sync.Once
	done := func(status int, h http.Header, err error) {
		once.Do(func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			s.active--
			s.probe = false
			if status == 499 {
				return
			}
			if err != nil || status == 429 || status >= 500 {
				s.epoch++
				s.failures++
				shift := min(s.failures-1, 6)
				delay := time.Second * time.Duration(1<<shift)
				if h != nil {
					v := h.Get("Retry-After")
					if n, e := strconv.Atoi(v); e == nil && n > 0 {
						delay = max(delay, time.Duration(min(n, 300))*time.Second)
					} else if t, e := http.ParseTime(v); e == nil {
						delay = max(delay, min(time.Until(t), 300*time.Second))
					}
				}
				s.until = time.Now().Add(delay)
			} else if epoch == s.epoch {
				s.failures = 0
				s.until = time.Time{}
			}
		})
	}
	return u, done, true
}
