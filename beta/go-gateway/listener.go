package main

import (
	"net"
	"sync"
)

// Admission bounds TCP connections as well as active HTTP requests. Idle peers
// and slow unauthorized uploads must not bypass the request concurrency limit.
type limitedListener struct {
	net.Listener
	slots chan struct{}
}
type admittedConn struct {
	net.Conn
	release func()
	once    sync.Once
}

func (c *admittedConn) Close() error { err := c.Conn.Close(); c.once.Do(c.release); return err }
func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		c, e := l.Listener.Accept()
		if e != nil {
			return nil, e
		}
		select {
		case l.slots <- struct{}{}:
			return &admittedConn{Conn: c, release: func() { <-l.slots }}, nil
		default:
			c.Close()
		}
	}
}
func limitConnections(l net.Listener, n int) net.Listener {
	return &limitedListener{Listener: l, slots: make(chan struct{}, n)}
}
