package stream

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/websocket"
)

// serveEvents attaches a WebSocket to the backend's push channel: JSON text
// frames, server to client only.
//
// It is one channel for the whole backend rather than one per producer. A PTY
// exit is what flows through it today; the git, watch and helm services
// (DESIGN.md §3.2) push their events onto the same socket, which is why the
// envelope carries a type instead of the endpoint implying one.
func (s *Server) serveEvents(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(w, r) {
		return
	}

	ws, upgraded := upgrade(w, r)
	if !upgraded {
		return
	}

	c := newConn(ws)
	s.register(c, true)
	defer s.unregister(c)

	go c.writePump()

	// Nothing inbound is expected. The read loop is what notices the client
	// going away, and it holds the handler open until then.
	c.drainReads()
}

// publish sends an event to every subscribed connection.
//
// A subscriber too far behind loses events the same way a terminal loses output:
// the queue is bounded and drops the oldest. An event channel that could block
// would put a stalled webview in the path of a PTY exiting.
func (s *Server) publish(e envelope) {
	// Every payload published here is a struct built in this package, so this
	// cannot fail.
	data, _ := json.Marshal(e)

	s.mu.Lock()
	subscribers := make([]*conn, 0, len(s.conns))
	for c, wantsEvents := range s.conns {
		if wantsEvents {
			subscribers = append(subscribers, c)
		}
	}
	s.mu.Unlock()

	// Outside the lock: send never blocks, but a publisher holding the server's
	// lock while touching connections is a shape that stops being true the first
	// time something in that path needs the lock back.
	for _, c := range subscribers {
		c.send(websocket.TextMessage, data)
	}
}
