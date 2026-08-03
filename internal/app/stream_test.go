package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/txn2/m6t/internal/pty"
	"github.com/txn2/m6t/internal/stream"
)

// readTimeout bounds every read. A shell that never answers fails the test
// rather than hanging the suite.
const readTimeout = 15 * time.Second

// windowsGOOS is the runtime.GOOS value for Windows.
const windowsGOOS = "windows"

// This is the end-to-end test the transport exists to make possible: a socket
// opened with the launch token, carrying a real shell's I/O.
//
// It runs here rather than in internal/stream because this is where the real
// wiring lives. internal/stream is tested against a fake Terminals — correctly,
// since it must not know what a PTY is — which leaves the adapter between the two
// services untested by construction. That adapter is exactly the kind of code
// that looks obviously right and gets a channel's close semantics wrong, so the
// composition is what gets exercised here.
func TestATerminalSessionEchoesOverTheStreamSocket(t *testing.T) {
	application, endpoint := startApp(t)
	id := createSession(t, application, nil)

	c := dialTerminal(t, endpoint, id)
	c.write([]byte("echo m6t-round-trip\r"))

	if got := c.awaitOutput("m6t-round-trip"); !got {
		t.Error("the shell's echo never came back over the socket")
	}
}

// Resizing has to reach the child, not just be recorded. `stty size` asks the
// kernel what the terminal's dimensions are, so its answer is the child's view —
// the only view that matters for how a program renders.
func TestResizeControlFrameChangesWhatTheChildSees(t *testing.T) {
	if runtime.GOOS == windowsGOOS {
		t.Skip("stty is not available on Windows; the resize path is covered by internal/stream")
	}

	application, endpoint := startApp(t)
	id := createSession(t, application, []string{"/bin/sh"})

	c := dialTerminal(t, endpoint, id)
	c.control(`{"type":"resize","payload":{"cols":132,"rows":43}}`)

	// The resize is applied on the socket's read loop, and stty reads the size at
	// the moment it runs, so the command has to be issued after the resize has
	// landed. Retrying is what makes that ordering reliable without a sleep.
	deadline := time.Now().Add(readTimeout)
	for time.Now().Before(deadline) {
		c.write([]byte("stty size\r"))
		if c.awaitOutputFor("43 132", 2*time.Second) {
			return
		}
	}
	t.Error("the child never reported the new window size; `stty size` did not show 43 132")
}

// A close message must end the child. It is the only thing that does: the socket
// closing does not, because PTYs survive tab switches (DESIGN.md §3.2).
func TestCloseControlFrameEndsTheChildAndReportsIt(t *testing.T) {
	application, endpoint := startApp(t)
	id := createSession(t, application, longRunningCommand())

	c := dialTerminal(t, endpoint, id)
	c.control(`{"type":"close"}`)

	frame := c.awaitEnvelope()
	if frame.Type != "exit" {
		t.Errorf("frame type = %q, want an exit", frame.Type)
	}

	// The session is gone from the manager, which is what stops a killed terminal
	// from being reattachable.
	if _, err := application.terminals.Attach(pty.SessionID(id)); !errors.Is(err, pty.ErrNoSuchSession) {
		t.Errorf("Attach after close = %v, want ErrNoSuchSession", err)
	}
}

// A shell that exits on its own has to be reported the same way one that was
// killed is — the terminal tab's "your shell exited" state depends on it.
func TestAChildThatExitsOnItsOwnIsReported(t *testing.T) {
	application, endpoint := startApp(t)
	id := createSession(t, application, exitingCommand())

	c := dialTerminal(t, endpoint, id)

	frame := c.awaitEnvelope()
	if frame.Type != "exit" {
		t.Errorf("frame type = %q, want an exit", frame.Type)
	}
	if frame.Payload.Code != 7 {
		t.Errorf("exit code = %d, want 7 — the child's own status", frame.Payload.Code)
	}
}

// The adapter's job is to keep a detach distinguishable from an exit. Both close
// the PTY service's channels; only one carries a status, and a detach reported as
// an exit would tell the UI a live shell had died.
func TestDetachingLeavesTheSessionRunning(t *testing.T) {
	application, endpoint := startApp(t)
	id := createSession(t, application, longRunningCommand())

	first := dialTerminal(t, endpoint, id)
	first.write([]byte("x"))
	if err := first.ws.Close(); err != nil {
		t.Fatalf("closing the socket: %v", err)
	}

	// Reattaching proves the session outlived the socket. It also exercises the
	// path a project-tab switch takes.
	second := dialTerminal(t, endpoint, id)
	second.write([]byte("echo still-here\r"))
	if !second.awaitOutput("still-here") {
		t.Error("the session did not survive its consumer disconnecting")
	}
}

// The endpoint is the only thing that crosses the Wails bridge, and it is
// useless without both halves.
func TestStreamEndpointIsUnavailableUntilStartup(t *testing.T) {
	application := newApp()

	if _, err := application.StreamEndpoint(); err == nil {
		t.Error("StreamEndpoint() succeeded before startup; the listener is not up yet")
	}
}

func TestOptionsStartTheStreamServerOnStartup(t *testing.T) {
	opts := Options(testAssets)
	if opts.OnStartup == nil {
		t.Fatal("OnStartup is nil; the stream listener would never come up")
	}

	application, ok := opts.Bind[0].(*App)
	if !ok {
		t.Fatalf("Bind[0] is %T, want *App", opts.Bind[0])
	}
	opts.OnStartup(context.Background())
	t.Cleanup(func() { opts.OnShutdown(context.Background()) })

	endpoint, err := application.StreamEndpoint()
	if err != nil {
		t.Fatalf("StreamEndpoint() after startup: %v", err)
	}
	if endpoint.Port <= 0 || endpoint.Token == "" {
		t.Errorf("endpoint = %+v, want a port and a token", endpoint)
	}
}

// Quitting must close the sockets as well as the sessions. A hijacked connection
// is not something http.Server.Shutdown touches, so a missed close here is a
// window that will not go away.
func TestShutdownClosesTheStreamSocketsAndTheSessions(t *testing.T) {
	opts := Options(testAssets)
	application, ok := opts.Bind[0].(*App)
	if !ok {
		t.Fatalf("Bind[0] is %T, want *App", opts.Bind[0])
	}
	opts.OnStartup(context.Background())

	endpoint, err := application.StreamEndpoint()
	if err != nil {
		t.Fatalf("StreamEndpoint() after startup: %v", err)
	}
	id, err := application.terminals.Create(pty.Options{Command: longRunningCommand()})
	if err != nil {
		t.Fatalf("creating a terminal session: %v", err)
	}
	c := dialTerminal(t, endpoint, string(id))

	opts.OnShutdown(context.Background())

	if err := c.ws.SetReadDeadline(time.Now().Add(readTimeout)); err != nil {
		t.Fatalf("setting a read deadline: %v", err)
	}
	if _, data, err := c.ws.ReadMessage(); err == nil {
		t.Errorf("the socket stayed open after shutdown and delivered %q", data)
	}
	if _, err := application.StreamEndpoint(); err == nil {
		t.Error("StreamEndpoint() still reports an endpoint after shutdown")
	}
}

// startApp builds an application, brings its listener up, and tears both down
// with the test.
func startApp(t *testing.T) (*App, stream.Endpoint) {
	t.Helper()

	application := newApp()
	if err := application.streams.Start(); err != nil {
		t.Fatalf("starting the stream server: %v", err)
	}
	t.Cleanup(func() {
		application.streams.Shutdown()
		application.terminals.Shutdown()
	})

	endpoint, err := application.StreamEndpoint()
	if err != nil {
		t.Fatalf("reading the stream endpoint: %v", err)
	}
	return application, endpoint
}

// createSession starts a PTY session and returns the identifier the socket path
// names.
func createSession(t *testing.T, application *App, argv []string) string {
	t.Helper()

	id, err := application.terminals.Create(pty.Options{Command: argv})
	if err != nil {
		t.Fatalf("creating a terminal session: %v", err)
	}
	return string(id)
}

// terminal is a test's side of one terminal socket.
type terminal struct {
	t  *testing.T
	ws *websocket.Conn
}

// exitFrame is a control frame from the server, decoded to what these tests
// assert on.
type exitFrame struct {
	Type    string `json:"type"`
	Payload struct {
		Code int `json:"code"`
	} `json:"payload"`
}

// dialTerminal opens a socket the way the frontend will: the token as a
// subprotocol, because the browser WebSocket API cannot set headers.
func dialTerminal(t *testing.T, endpoint stream.Endpoint, id string) *terminal {
	t.Helper()

	dialer := &websocket.Dialer{
		Subprotocols: []string{"m6t.v1", "m6t.token." + endpoint.Token},
	}
	url := "ws://127.0.0.1:" + strconv.Itoa(endpoint.Port) + "/pty/" + id
	ws, resp, err := dialer.Dial(url, http.Header{})
	if resp != nil {
		defer func() { _ = resp.Body.Close() }()
	}
	if err != nil {
		t.Fatalf("dialing %s: %v", url, err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	return &terminal{t: t, ws: ws}
}

func (c *terminal) write(input []byte) {
	c.t.Helper()
	if err := c.ws.WriteMessage(websocket.BinaryMessage, input); err != nil {
		c.t.Fatalf("writing terminal input: %v", err)
	}
}

func (c *terminal) control(message string) {
	c.t.Helper()
	if err := c.ws.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
		c.t.Fatalf("writing a control frame: %v", err)
	}
}

// awaitOutput reports whether the wanted text appears in the session's output.
func (c *terminal) awaitOutput(want string) bool {
	c.t.Helper()
	return c.awaitOutputFor(want, readTimeout)
}

// awaitOutputFor is awaitOutput with an explicit budget, for the caller that
// retries a command rather than waiting once.
//
// The match is over accumulated output because a PTY splits writes wherever it
// likes: the string being looked for can arrive across two frames, and asserting
// per frame would be a test that passes on chunk boundaries.
func (c *terminal) awaitOutputFor(want string, budget time.Duration) bool {
	c.t.Helper()

	var seen bytes.Buffer
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if err := c.ws.SetReadDeadline(deadline); err != nil {
			c.t.Fatalf("setting a read deadline: %v", err)
		}
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			return false
		}
		if kind != websocket.BinaryMessage {
			continue
		}
		seen.Write(data)
		if strings.Contains(seen.String(), want) {
			return true
		}
	}
	return false
}

// awaitEnvelope returns the next control frame, skipping the session output that
// precedes it.
func (c *terminal) awaitEnvelope() exitFrame {
	c.t.Helper()

	deadline := time.Now().Add(readTimeout)
	for {
		if err := c.ws.SetReadDeadline(deadline); err != nil {
			c.t.Fatalf("setting a read deadline: %v", err)
		}
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			c.t.Fatalf("reading from the socket: %v", err)
		}
		if kind != websocket.TextMessage {
			continue
		}
		var frame exitFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			c.t.Fatalf("decoding %q: %v", data, err)
		}
		return frame
	}
}

// exitingCommand returns an argv for a child that exits promptly with status 7.
func exitingCommand() []string {
	if runtime.GOOS == windowsGOOS {
		return []string{"cmd.exe", "/c", "exit 7"}
	}
	return []string{"/bin/sh", "-c", "exit 7"}
}
