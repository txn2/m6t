package stream

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeSessionID is the session the fake terminal service holds.
const fakeSessionID = "pty-1"

// readTimeout bounds every read a test does. A protocol bug that loses a frame
// shows up as a failed read here rather than as a hung test binary.
const readTimeout = 10 * time.Second

// absenceTimeout is how long a test waits before concluding a frame is not
// coming. Asserting an absence needs a short wait, not a generous one.
const absenceTimeout = 250 * time.Millisecond

// shortDeadline is the read deadline for an assertion that nothing arrives.
func shortDeadline() time.Time {
	return time.Now().Add(absenceTimeout)
}

// errNoFakeSession stands in for the PTY service's own unknown-session error.
var errNoFakeSession = errors.New("no such fake session")

// dimension is one recorded resize.
type dimension struct {
	cols uint16
	rows uint16
}

// fakeSession is a terminal session the test drives directly: it produces output
// when the test says so and ends when the test says so.
//
// It reproduces the PTY service's channel contract, which the stream server
// depends on: Chunks closes when the session ends OR when the consumer detaches,
// and Exited yields a code in the first case and nothing in the second.
type fakeSession struct {
	replay []byte

	mu     sync.Mutex
	chunks chan []byte
	exited chan int
	closed bool
}

func newFakeSession(replay []byte) *fakeSession {
	return &fakeSession{
		replay: replay,
		chunks: make(chan []byte),
		exited: make(chan int, 1),
	}
}

// output hands the server one chunk, waiting for it to be taken.
//
// Waiting is deliberate: the forwarder must never block, so this send returns
// promptly or the server has a backpressure bug. The timeout is what turns that
// bug into a failure instead of a hang.
func (s *fakeSession) output(t *testing.T, chunk []byte) {
	t.Helper()
	select {
	case s.chunks <- chunk:
	case <-time.After(readTimeout):
		t.Error("the stream server stopped consuming session output")
	}
}

// exit ends the session with a status, as a child process exiting does.
func (s *fakeSession) exit(code int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.chunks)
	s.exited <- code
	close(s.exited)
}

// detach releases the consumer: both channels close and no status is published.
func (s *fakeSession) detach() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.chunks)
	close(s.exited)
}

// fakeTerminals is a Terminals that records what the server asked of it.
type fakeTerminals struct {
	mu       sync.Mutex
	sessions map[string]*fakeSession
	written  bytes.Buffer
	resizes  []dimension
	kills    int
	detaches int
}

func newFakeTerminals() *fakeTerminals {
	return newFakeTerminalsWithReplay(nil)
}

func newFakeTerminalsWithReplay(replay []byte) *fakeTerminals {
	return &fakeTerminals{
		sessions: map[string]*fakeSession{fakeSessionID: newFakeSession(replay)},
	}
}

// session returns the one session the fake holds.
func (f *fakeTerminals) session() *fakeSession {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sessions[fakeSessionID]
}

func (f *fakeTerminals) Attach(id string) (Attachment, error) {
	f.mu.Lock()
	session, ok := f.sessions[id]
	f.mu.Unlock()
	if !ok {
		return Attachment{}, fmt.Errorf("session %s: %w", id, errNoFakeSession)
	}
	return Attachment{
		Replay: session.replay,
		Chunks: session.chunks,
		Exited: session.exited,
		Detach: func() {
			f.mu.Lock()
			f.detaches++
			f.mu.Unlock()
			session.detach()
		},
	}, nil
}

func (f *fakeTerminals) Write(id string, p []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sessions[id]; !ok {
		return fmt.Errorf("session %s: %w", id, errNoFakeSession)
	}
	f.written.Write(p)
	return nil
}

func (f *fakeTerminals) Resize(id string, cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sessions[id]; !ok {
		return fmt.Errorf("session %s: %w", id, errNoFakeSession)
	}
	f.resizes = append(f.resizes, dimension{cols: cols, rows: rows})
	return nil
}

func (f *fakeTerminals) Kill(id string) error {
	f.mu.Lock()
	session, ok := f.sessions[id]
	if ok {
		f.kills++
	}
	f.mu.Unlock()
	if !ok {
		return fmt.Errorf("session %s: %w", id, errNoFakeSession)
	}
	// A killed child reports -1, the same as the PTY service does for a session
	// terminated by a signal.
	session.exit(-1)
	return nil
}

// recorded is what the fake terminal service was asked to do.
type recorded struct {
	written  string
	resizes  []dimension
	kills    int
	detaches int
}

// snapshot reports what the fake recorded.
func (f *fakeTerminals) snapshot() recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return recorded{
		written:  f.written.String(),
		resizes:  append([]dimension(nil), f.resizes...),
		kills:    f.kills,
		detaches: f.detaches,
	}
}

// startTestServer brings up a real listener and tears it down with the test.
func startTestServer(t *testing.T, terminals Terminals) (*Server, Endpoint) {
	t.Helper()

	server := New(terminals)
	if err := server.Start(); err != nil {
		t.Fatalf("starting the stream server: %v", err)
	}
	t.Cleanup(server.Shutdown)

	endpoint, err := server.Endpoint()
	if err != nil {
		t.Fatalf("reading the endpoint of a started server: %v", err)
	}
	return server, endpoint
}

// socketURL builds the ws:// URL for a path on an endpoint.
func socketURL(e Endpoint, path string) string {
	return "ws://127.0.0.1:" + strconv.Itoa(e.Port) + path
}

// client is a test's side of a stream connection.
type client struct {
	t  *testing.T
	ws *websocket.Conn
}

// dial connects with the token in the Authorization header.
func dial(t *testing.T, e Endpoint, path string) *client {
	t.Helper()
	header := http.Header{}
	header.Set("Authorization", bearerPrefix+e.Token)
	return dialWith(t, &websocket.Dialer{}, e, path, header)
}

// dialSubprotocol connects the way a browser has to: the token as a
// subprotocol, because the WebSocket API cannot set headers.
func dialSubprotocol(t *testing.T, e Endpoint, path string) *client {
	t.Helper()
	dialer := &websocket.Dialer{
		Subprotocols: []string{protocolVersion, authSubprotocolPrefix + e.Token},
	}
	return dialWith(t, dialer, e, path, nil)
}

func dialWith(t *testing.T, dialer *websocket.Dialer, e Endpoint, path string, header http.Header) *client {
	t.Helper()
	ws, resp, err := dialer.Dial(socketURL(e, path), header)
	if resp != nil {
		defer func() { _ = resp.Body.Close() }()
	}
	if err != nil {
		t.Fatalf("dialing %s: %v", path, err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	return &client{t: t, ws: ws}
}

// handshakeStatus dials and reports the HTTP status of the handshake response,
// which is how a refusal is observed.
func handshakeStatus(t *testing.T, e Endpoint, path string, headers map[string]string) int {
	t.Helper()

	header := http.Header{}
	for name, value := range headers {
		header.Set(name, value)
	}
	ws, resp, err := websocket.DefaultDialer.Dial(socketURL(e, path), header)
	if ws != nil {
		_ = ws.Close()
	}
	if resp == nil {
		t.Fatalf("dialing %s produced no handshake response: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

// read returns the next message, failing the test if none arrives.
func (c *client) read() (kind int, data []byte) {
	c.t.Helper()
	if err := c.ws.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		c.t.Fatalf("setting a read deadline: %v", err)
	}
	kind, data, err := c.ws.ReadMessage()
	if err != nil {
		c.t.Fatalf("reading from the socket: %v", err)
	}
	return kind, data
}

// readBinary returns the next message, requiring it to be a data frame.
func (c *client) readBinary() []byte {
	c.t.Helper()
	kind, data := c.read()
	if kind != websocket.BinaryMessage {
		c.t.Fatalf("frame kind = %d with payload %q, want a binary frame", kind, data)
	}
	return data
}

// serverFrame is a text frame from the server, decoded to the fields the tests
// assert on.
type serverFrame struct {
	Type    string `json:"type"`
	Payload struct {
		Code         int   `json:"code"`
		DroppedBytes int64 `json:"droppedBytes"`
	} `json:"payload"`
}

// readEnvelope returns the next message, requiring it to be a control or event
// frame.
func (c *client) readEnvelope() serverFrame {
	c.t.Helper()
	kind, data := c.read()
	if kind != websocket.TextMessage {
		c.t.Fatalf("frame kind = %d with payload %q, want a text frame", kind, data)
	}
	var frame serverFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		c.t.Fatalf("decoding %q: %v", data, err)
	}
	return frame
}

// sendBinary writes terminal input.
func (c *client) sendBinary(data []byte) {
	c.t.Helper()
	if err := c.ws.WriteMessage(websocket.BinaryMessage, data); err != nil {
		c.t.Fatalf("writing a binary frame: %v", err)
	}
}

// sendControl writes a raw control frame, so a test can send malformed JSON and
// unknown types as easily as valid messages.
func (c *client) sendControl(payload string) {
	c.t.Helper()
	if err := c.ws.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
		c.t.Fatalf("writing a control frame: %v", err)
	}
}

// expectClosed requires the server to have ended the connection.
func (c *client) expectClosed() {
	c.t.Helper()
	if err := c.ws.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		c.t.Fatalf("setting a read deadline: %v", err)
	}
	if _, data, err := c.ws.ReadMessage(); err == nil {
		c.t.Errorf("the connection stayed open and delivered %q, want it closed", data)
	}
}

// expectNormalClosure requires the connection to end with a clean WebSocket
// closure rather than a dropped socket, which is how a client distinguishes a
// finished session from a crash.
func (c *client) expectNormalClosure() {
	c.t.Helper()
	if err := c.ws.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		c.t.Fatalf("setting a read deadline: %v", err)
	}
	for {
		_, _, err := c.ws.ReadMessage()
		if err == nil {
			continue
		}
		if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
			c.t.Errorf("connection ended with %v, want a normal closure", err)
		}
		return
	}
}

// eventually retries until condition holds or the deadline passes. It is for the
// handful of assertions about state a background goroutine reaches — a detach
// recorded after the socket closed, a connection removed from the registry —
// where the observable event and the state change are not the same instant.
func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Errorf("timed out waiting for %s", what)
}
