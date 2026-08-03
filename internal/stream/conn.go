package stream

import (
	"encoding/json"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

// frame is one queued outbound message.
type frame struct {
	kind int
	data []byte
}

// conn is one WebSocket connection with a bounded outbound queue.
//
// The queue is the point of this type. A PTY child writes as fast as the
// terminal will take it, and a webview that has stopped reading — mid-repaint,
// mid-garbage-collection, or wedged — must not be able to stall the child. So
// the queue is fixed-size and a full queue discards its oldest frame instead of
// waiting: the stream stays live and loses history rather than staying complete
// and freezing the shell.
//
// Lost bytes are reported, not hidden. Every discarded byte is counted, and the
// next frame to be written is preceded by a resync marker carrying the total, so
// a renderer knows the character stream has a hole in it and can redraw from a
// fresh attach instead of painting corrupted output.
//
// gorilla/websocket permits one concurrent writer and one concurrent reader, so
// writePump is the only thing here that writes and each handler runs exactly one
// read loop.
type conn struct {
	ws *websocket.Conn

	// frames is the bounded queue. It is closed by finish, which is why only a
	// connection's single output producer may call that.
	frames chan frame

	// dropped counts bytes discarded since the last resync marker.
	dropped atomic.Int64

	done      chan struct{}
	closeOnce sync.Once
	finishOne sync.Once
}

// newConn wraps an upgraded socket. The read limit is set here rather than at
// each call site so no handler can forget it.
func newConn(ws *websocket.Conn) *conn {
	ws.SetReadLimit(maxMessageBytes)
	return &conn{
		ws:     ws,
		frames: make(chan frame, outboundQueue),
		done:   make(chan struct{}),
	}
}

// send queues a frame. It never blocks: a full queue loses its oldest frame,
// and a frame that still does not fit is itself counted as lost.
//
// Only a connection's single output producer may call this, which is what makes
// the closed-channel case in finish unreachable.
func (c *conn) send(kind int, data []byte) {
	f := frame{kind: kind, data: data}
	select {
	case c.frames <- f:
		return
	default:
	}

	select {
	case oldest := <-c.frames:
		c.dropped.Add(int64(len(oldest.data)))
	default:
	}

	select {
	case c.frames <- f:
	default:
		c.dropped.Add(int64(len(f.data)))
	}
}

// finish stops accepting frames and lets writePump drain what is queued. It is
// how a session's last screenful and its exit frame reach a client that closes
// as soon as it sees them, instead of being cut off by the socket closing first.
func (c *conn) finish() {
	c.finishOne.Do(func() { close(c.frames) })
}

// writePump owns every write to the socket and returns when the queue is
// finished, the connection is closed, or a write fails.
func (c *conn) writePump() {
	defer c.close()

	for {
		select {
		case f, ok := <-c.frames:
			if !ok {
				c.drain()
				return
			}
			if !c.write(f) {
				return
			}
		case <-c.done:
			return
		}
	}
}

// drain finishes a closed queue: a trailing resync marker if anything was lost
// after the last frame, then a normal closure so the client can tell a finished
// session from a dropped socket.
func (c *conn) drain() {
	if !c.markResync() {
		return
	}
	closure := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "")
	// A failed close write means the peer is already gone, which is the state
	// the write was trying to reach.
	_ = c.ws.WriteMessage(websocket.CloseMessage, closure)
}

// write emits one frame, preceded by a resync marker when output was dropped
// since the last one. It reports whether the connection is still usable.
func (c *conn) write(f frame) bool {
	if !c.markResync() {
		return false
	}
	return c.ws.WriteMessage(f.kind, f.data) == nil
}

// markResync writes the pending resync marker, if any, and reports whether the
// connection is still usable. The counter is taken and cleared in one step so a
// concurrent drop is carried by the next marker rather than lost.
func (c *conn) markResync() bool {
	dropped := c.dropped.Swap(0)
	if dropped == 0 {
		return true
	}
	// The payload is a struct of an int built here, so this cannot fail.
	marker, _ := json.Marshal(envelope{
		Type:    typeResync,
		Payload: resyncPayload{DroppedBytes: dropped},
	})
	return c.ws.WriteMessage(websocket.TextMessage, marker) == nil
}

// close releases the connection. It is idempotent because both pumps and the
// server's shutdown all reach for it.
func (c *conn) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.ws.Close()
	})
}

// drainReads reads and discards inbound messages until the peer goes away. A
// push-only endpoint still has to read: it is how the socket notices a closed
// client, and how gorilla/websocket gets to answer ping frames.
func (c *conn) drainReads() {
	defer c.close()

	for {
		if _, _, err := c.ws.ReadMessage(); err != nil {
			return
		}
	}
}
