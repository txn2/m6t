package stream

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/websocket"
)

// serveTerminal attaches a WebSocket to a terminal session: binary frames carry
// the character stream in both directions, text frames carry control messages.
//
// The order of the three refusals matters. The token is checked first, so an
// unauthenticated caller cannot use this endpoint to discover which session IDs
// exist. The attach comes next, so an unknown session is a 404 on a plain HTTP
// response rather than a socket that opens and immediately dies. Only then is
// the connection upgraded — and the upgrade is where a disallowed Origin is
// refused with a 403.
func (s *Server) serveTerminal(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(w, r) {
		return
	}

	id := r.PathValue(sessionIDParam)
	attachment, err := s.terminals.Attach(id)
	if err != nil {
		http.Error(w, "no such terminal session", http.StatusNotFound)
		return
	}

	ws, upgraded := upgrade(w, r)
	if !upgraded {
		// The attach has to be undone or the session keeps a queue for a consumer
		// that never arrived.
		attachment.Detach()
		return
	}

	c := newConn(ws)
	s.register(c, false)
	defer s.unregister(c)

	go c.writePump()
	go s.forward(c, attachment)

	// The read loop holds the handler open for the life of the connection.
	s.readTerminal(c, id)

	// The client is gone. Releasing the attachment stops the session from
	// queueing output for it, and unblocks the forwarder if it is still there.
	attachment.Detach()
}

// forward carries a session's output to the client and then its exit status.
//
// It runs until the session ends or the consumer is detached, and it is the only
// producer of frames on this connection — which is what makes finish safe to
// call here and nowhere else.
func (s *Server) forward(c *conn, attachment Attachment) {
	if len(attachment.Replay) > 0 {
		c.send(websocket.BinaryMessage, attachment.Replay)
	}
	for chunk := range attachment.Chunks {
		c.send(websocket.BinaryMessage, chunk)
	}

	code, exited := <-attachment.Exited
	if !exited {
		// Detached before the child ended. The session is still running for
		// whoever else is attached, so nothing is reported.
		return
	}

	exit := envelope{Type: typeExit, Payload: exitPayload{Code: code}}
	// The payload is a struct of an int built here, so this cannot fail.
	data, _ := json.Marshal(exit)
	c.send(websocket.TextMessage, data)

	// The same exit goes to the event channel: a terminal tab renders it, and
	// the rest of the UI learns a session ended without having to be attached
	// to it.
	s.publish(exit)

	// Queue finished rather than socket closed, so the exit frame and the output
	// before it are written before the connection goes away.
	c.finish()
}

// readTerminal carries the client's keystrokes and control messages to the
// session until the connection closes.
//
// A read error ends the loop and closes the socket. It does not end the session:
// PTYs are backend-owned and survive a webview reload or a tab switch
// (DESIGN.md §3.2), so only an explicit close message kills one.
func (s *Server) readTerminal(c *conn, id string) {
	defer c.close()

	for {
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}

		switch kind {
		case websocket.BinaryMessage:
			if err := s.terminals.Write(id, data); err != nil {
				return
			}
		case websocket.TextMessage:
			if !s.applyControl(id, data) {
				return
			}
		}
	}
}

// applyControl performs one control message and reports whether the connection
// should stay open.
//
// A frame that does not decode, or names a type this version does not know, is
// ignored. The protocol has to be able to grow a message without every older
// backend dropping the connection when it sees one.
func (s *Server) applyControl(id string, data []byte) bool {
	var message control
	if err := json.Unmarshal(data, &message); err != nil {
		return true
	}

	switch message.Type {
	case typeResize:
		// A resize that fails means the session is gone; there is nothing left
		// for this connection to carry.
		return s.terminals.Resize(id, message.Payload.Cols, message.Payload.Rows) == nil
	case typeClose:
		// The connection stays up: killing the session ends the forwarder, which
		// writes the exit frame and then closes. Closing here instead would race
		// that write and cost the client the status it asked for.
		//
		// A kill that fails means the session was already gone, so no exit is
		// coming and there is nothing left to wait for.
		return s.terminals.Kill(id) == nil
	default:
		return true
	}
}
