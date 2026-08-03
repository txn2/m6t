package stream

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// Server is the loopback stream server: one HTTP listener on 127.0.0.1 serving
// WebSocket endpoints for terminal I/O and backend-push events.
//
// One instance per application. The token is minted at construction and lives
// as long as the process, so a socket opened by this launch cannot be reopened
// by anything that learned the port from a previous one.
type Server struct {
	terminals Terminals
	token     string
	handler   http.Handler

	mu   sync.Mutex
	http *http.Server
	port int

	// startErr keeps the reason the listener never came up, so Endpoint can
	// tell the frontend why instead of leaving it to time out on a socket that
	// was never going to answer.
	startErr error

	// conns holds every live connection so shutdown can close them: an upgraded
	// connection is hijacked, and http.Server.Shutdown does not touch those. The
	// value marks a connection subscribed to /events.
	conns map[*conn]bool
}

// New builds a server around the terminal service it will carry. It binds
// nothing — Start does that — so an application can compose the server before
// it has a window to report a bind failure in.
func New(terminals Terminals) *Server {
	server := &Server{
		terminals: terminals,

		// rand.Text is a 26-character base32 string from crypto/rand: ~130 bits
		// of entropy, URL- and header-safe, and it cannot fail in a way a caller
		// must handle.
		token: rand.Text(),

		conns: make(map[*conn]bool),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /pty/{"+sessionIDParam+"}", server.serveTerminal)
	mux.HandleFunc("GET /events", server.serveEvents)
	server.handler = mux

	return server
}

// Start binds the loopback listener and serves it in the background. It is what
// the application calls on startup; a failure here is recorded and surfaced
// through Endpoint.
func (s *Server) Start() error {
	return s.listenAndServe(loopbackAddr)
}

// listenAndServe is Start with the address as a parameter, so the failure path
// is reachable from a test rather than taken on trust.
func (s *Server) listenAndServe(addr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.http != nil {
		return fmt.Errorf("stream server is already serving on port %d", s.port)
	}

	// A ListenConfig rather than net.Listen: the listener's lifetime is the
	// application's, so the context it is bound to is the one that never
	// cancels, and stating that is better than a bare call that implies it.
	var config net.ListenConfig
	listener, err := config.Listen(context.Background(), "tcp", addr)
	if err != nil {
		s.startErr = fmt.Errorf("binding the stream server: %w", err)
		return s.startErr
	}

	local, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		s.startErr = fmt.Errorf("stream listener reports a %T address, want *net.TCPAddr", listener.Addr())
		return s.startErr
	}

	server := &http.Server{Handler: s.handler, ReadHeaderTimeout: readHeaderTimeout}
	s.http, s.port, s.startErr = server, local.Port, nil

	// Serve returns when the listener closes, which is what Shutdown does.
	go func() { _ = server.Serve(listener) }()

	return nil
}

// Endpoint reports where to connect and with what token.
//
// It fails until the listener is up, carrying Start's own error when there was
// one: a frontend that cannot open a socket should be told why.
func (s *Server) Endpoint() (Endpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.http == nil {
		if s.startErr != nil {
			return Endpoint{}, s.startErr
		}
		return Endpoint{}, errNotStarted
	}
	return Endpoint{Port: s.port, Token: s.token}, nil
}

// Shutdown closes every connection and stops the listener. It does not end any
// terminal session: the PTY service owns those, and killing them is its
// shutdown, not this one.
func (s *Server) Shutdown() {
	s.mu.Lock()
	server := s.http
	s.http = nil
	live := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		live = append(live, c)
	}
	s.conns = make(map[*conn]bool)
	s.mu.Unlock()

	// Upgraded connections are hijacked, so http.Server.Shutdown neither waits
	// for them nor closes them. Closing them first is what makes the graceful
	// shutdown below finish immediately instead of timing out.
	for _, c := range live {
		c.close()
	}

	if server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	// The app is quitting; a connection that will not close in time is dropped
	// rather than allowed to hold it open.
	_ = server.Shutdown(ctx)
}

// upgrade turns an authorized request into a WebSocket connection, reporting
// whether it succeeded.
//
// The Upgrader is built here, at the point of use, rather than held on the
// Server: it carries no state — a subprotocol list and the origin policy — and
// keeping the policy in the same function as the call it guards is what makes
// the guarantee readable. There is no path to Upgrade that does not go past
// CheckOrigin.
//
// The origin check IS the hook rather than a step in front of it, because
// gorilla answers a refused origin with a 403 before writing any upgrade
// response — which is exactly the behavior wanted.
func upgrade(w http.ResponseWriter, r *http.Request) (*websocket.Conn, bool) {
	upgrader := websocket.Upgrader{
		Subprotocols: []string{protocolVersion},
		CheckOrigin: func(r *http.Request) bool {
			return originAllowed(r.Header.Get("Origin"))
		},
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade has already written the failure, including the 403 a refused
		// origin gets.
		return nil, false
	}
	return ws, true
}

// authorized reports whether a request presents the launch token, writing the
// refusal itself when it does not.
//
// This runs before the upgrade, so a client with the wrong token reads a 401
// rather than getting a socket it is not allowed to use. The comparison is
// constant-time: the token is a secret, and a fast reject leaks its prefix.
func (s *Server) authorized(w http.ResponseWriter, r *http.Request) bool {
	presented := []byte(requestToken(r))
	if subtle.ConstantTimeCompare(presented, []byte(s.token)) == 1 {
		return true
	}
	http.Error(w, "unauthorized", http.StatusUnauthorized)
	return false
}

// register records a live connection so shutdown can close it, and marks
// whether it wants backend-push events.
func (s *Server) register(c *conn, wantsEvents bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns[c] = wantsEvents
}

// unregister forgets a connection that has closed.
func (s *Server) unregister(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, c)
}
