package main

import "time"

type requestWindow struct {
	start time.Time
	used  int64
}

// A fixed window begins at the first accepted model request. Configuration
// reloads retain counters by stable key ID; rejected calls never spend quota.
// This is a per-process rate policy, reset when the gateway is restarted.
func (g *gateway) takeRequest(k *Key, now time.Time) int {
	if k.RequestLimit == 0 {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	w := g.requestWindows[k.ID]
	duration := time.Duration(k.RequestWindowSeconds) * time.Second
	if w.start.IsZero() || !now.Before(w.start.Add(duration)) {
		w = requestWindow{start: now}
	}
	if w.used >= k.RequestLimit {
		return max(1, int((w.start.Add(duration).Sub(now)+time.Second-1)/time.Second))
	}
	w.used++
	g.requestWindows[k.ID] = w
	return 0
}
