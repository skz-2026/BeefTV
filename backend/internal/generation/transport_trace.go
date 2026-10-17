package generation

import (
	"net/http"
	"net/http/httptrace"
	"sync/atomic"
)

// Keep evidence for the whole Client.Do, including redirects. A later TLS
// failure cannot prove that the original POST was not received.
type transportTrace struct {
	connected atomic.Bool
	phase     atomic.Value
}

func (t *transportTrace) attach(req *http.Request) *http.Request {
	t.phase.Store("connect")
	trace := &httptrace.ClientTrace{
		TLSHandshakeStart: func() { t.phase.Store("tls") },
		GotConn: func(httptrace.GotConnInfo) {
			t.connected.Store(true)
			t.phase.Store("request")
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err == nil {
				t.phase.Store("response_wait")
			}
		},
		GotFirstResponseByte: func() { t.phase.Store("response") },
	}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
}

func (t *transportTrace) result() (bool, string) {
	phase, _ := t.phase.Load().(string)
	return t.connected.Load(), phase
}
