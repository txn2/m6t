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

// PublishTree announces that dirs under a project's root may have changed
// (internal/watch's Events seam). It is the one entry point into this
// package for a producer other than a terminal connection: git and helm
// (DESIGN.md §3.2) get their own exported Publish method the same shape as
// this one when they land, rather than a generic "publish anything" call
// that would let a caller invent envelope types this file does not know
// about.
func (s *Server) PublishTree(root string, dirs []string) {
	s.publish(envelope{Type: typeTree, Payload: treePayload{Root: root, Dirs: dirs}})
}

// PublishGit announces that a project's git status may be stale (#8,
// PROTOCOL.md §5).
//
// It is a separate message from PublishTree rather than a second consumer of
// it, even though internal/app publishes both from the same watcher batch
// today. The tree message's payload is a list of directories a tree consumer
// filters against what it has loaded; a git consumer shares none of that
// contract, and the directories it most depends on — .git and .git/refs — are
// the ones the tree never loads and would be free to stop reporting.
func (s *Server) PublishGit(root string) {
	s.publish(envelope{Type: typeGit, Payload: gitPayload{Root: root}})
}

// PublishHealth announces that a project's live cluster health may be stale
// (#12, PROTOCOL.md §5).
//
// A third message rather than a third consumer of the first two, for the reason
// PublishGit gives and because the producer is different in kind: tree and git
// are published from a filesystem batch, and this is published from a watch
// connection to a cluster, at whatever rate that cluster changes.
func (s *Server) PublishHealth(root string) {
	s.publish(envelope{Type: typeHealth, Payload: healthPayload{Root: root}})
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
