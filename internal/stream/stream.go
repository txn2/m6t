// Package stream is m6t's loopback WebSocket transport (DESIGN.md §3.3): the
// channel that carries throughput-sensitive data between the Go backend and the
// webview, starting with PTY I/O.
//
// The Wails bridge handles RPC — open a file, run an apply, list projects. It is
// the wrong shape for a terminal, where a build log arrives as thousands of
// small writes and every one of them would cross a JSON marshaling boundary.
// So the backend also serves an HTTP listener on 127.0.0.1 with a random port
// and a per-launch bearer token, and the frontend opens sockets to it. The only
// thing the bridge carries is the Endpoint that says where and with what token.
//
// The wire protocol — frame kinds, the control envelope, the auth forms and the
// backpressure rule — is specified in PROTOCOL.md next to this file. It is a
// contract with the frontend, so it is written down rather than inferred from
// the handlers.
//
// This package spawns nothing and owns no process. It takes a Terminals seam in
// its constructor and moves bytes across it: the PTY service on the other side
// is a sibling that this package must not import, and the binding layer is what
// joins the two (CLAUDE.md, "Architecture map").
package stream

import (
	"errors"
	"time"
)

const (
	// loopbackAddr binds the listener. The interface is not configurable on
	// purpose: a stream server reachable from another host is a shell server,
	// and port 0 means the OS picks a free port so two m6t instances can run
	// side by side.
	loopbackAddr = "127.0.0.1:0"

	// protocolVersion is the WebSocket subprotocol the server negotiates. A
	// browser that offers subprotocols requires the server to select one, so
	// this is what gets echoed back when the token arrives as a subprotocol.
	protocolVersion = "m6t.v1"

	// authSubprotocolPrefix carries the bearer credential for clients that
	// cannot set request headers. The browser WebSocket API is one: it exposes
	// the subprotocol list and nothing else, which is the same reason the
	// Kubernetes API server accepts a credential this way.
	//
	// The identifier deliberately avoids the word this prefix contains: gosec
	// G101 matches on names, and a constant named for a credential — even one
	// holding a fixed, public prefix rather than a secret — is a finding this
	// repo has no way to record except by suppressing it.
	authSubprotocolPrefix = "m6t.token."

	// bearerPrefix is the Authorization header form, used by every client that
	// can set headers — the Go tests, and any tooling attached to a session.
	bearerPrefix = "Bearer "

	// wailsScheme and wailsHost are the origins the Wails webview reports:
	// wails://wails on macOS and Linux, http://wails.localhost on Windows.
	wailsScheme = "wails"
	wailsHost   = "wails.localhost"

	// localhostHost is the loopback name that does not parse as an IP.
	localhostHost = "localhost"

	// outboundQueue bounds the frames one connection may have waiting. It is
	// the whole of the backpressure policy: a client this far behind starts
	// losing frames rather than being allowed to slow the producer down. At
	// PTY chunk size that is a couple of megabytes of slack, which absorbs a
	// render stall without absorbing a wedged webview.
	outboundQueue = 64

	// maxMessageBytes bounds one inbound message. Terminal input is keystrokes
	// and pastes and control frames are tiny, so anything approaching this is
	// either a bug or an attempt to make the backend allocate.
	maxMessageBytes = 1 << 20

	// readHeaderTimeout bounds how long a connection may take to send its
	// request headers. A local client is immediate; the timeout is what stops
	// an opened-and-abandoned socket from holding a handler forever.
	readHeaderTimeout = 5 * time.Second

	// shutdownTimeout bounds the graceful close on the way out. The app is
	// quitting, so a connection that will not finish is dropped rather than
	// allowed to delay it.
	shutdownTimeout = 2 * time.Second

	// sessionIDParam is the path wildcard naming the terminal session.
	sessionIDParam = "sessionID"
)

// errNotStarted reports an Endpoint asked for before the listener is up.
var errNotStarted = errors.New("stream server is not started")

// Endpoint is what a frontend needs to open a socket: the port the listener
// actually got, and the token every connection must present.
//
// It crosses the Wails bridge, and it is the one piece of this package that
// must never be written to a log or an error message — a token in a log file
// outlives the launch it was minted for.
type Endpoint struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// Attachment is one consumer's view of a terminal session, in the terms this
// package needs: the scrollback to replay, the output that follows, how the
// child ended, and how to stop consuming.
//
// It mirrors the PTY service's own attachment rather than reusing it. Sibling
// services do not import each other, so the shape is restated here and the
// binding layer adapts one to the other — the cost of the seam, paid once.
type Attachment struct {
	// Replay is the scrollback at the moment of attaching.
	Replay []byte

	// Chunks carries output produced after the attach, and closes when the
	// session ends or the consumer detaches.
	Chunks <-chan []byte

	// Exited yields the child's exit code once. It closes without yielding
	// when the consumer detached before the child exited.
	Exited <-chan int

	// Detach releases the consumer. It must not be nil and it must be
	// idempotent: the server calls it on every path out of a connection,
	// including the one where the session had already ended.
	Detach func()
}

// Terminals is the PTY service as this package uses it. The methods take an
// opaque session identifier because that is all a transport needs to know: the
// server routes bytes to a name the frontend was given, and what a session is
// stays behind this seam.
type Terminals interface {
	Attach(id string) (Attachment, error)
	Write(id string, p []byte) error
	Resize(id string, cols, rows uint16) error
	Kill(id string) error
}
