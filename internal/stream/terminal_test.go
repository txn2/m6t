package stream

import (
	"errors"
	"testing"

	"github.com/gorilla/websocket"
)

// The scrollback is the first thing a reconnecting terminal needs: without it a
// tab switch shows an empty screen for a shell that has been running all day.
func TestAttachingReplaysScrollbackThenStreamsOutput(t *testing.T) {
	terminals := newFakeTerminalsWithReplay([]byte("$ make verify\n"))
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)

	if got := string(c.readBinary()); got != "$ make verify\n" {
		t.Errorf("first frame = %q, want the scrollback replay", got)
	}

	terminals.session().output(t, []byte("=== All checks passed ===\n"))
	if got := string(c.readBinary()); got != "=== All checks passed ===\n" {
		t.Errorf("second frame = %q, want the output that followed the attach", got)
	}
}

// A session with no scrollback must not open with an empty frame: an empty
// binary frame is indistinguishable from output to a renderer.
func TestAttachingASilentSessionSendsNothing(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)

	terminals.session().output(t, []byte("first"))
	if got := string(c.readBinary()); got != "first" {
		t.Errorf("first frame = %q, want the first real output", got)
	}
}

func TestBinaryFramesReachTheChildAsInput(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)
	c.sendBinary([]byte("echo hi\r"))

	eventually(t, "the client's input to reach the session", func() bool {
		return terminals.snapshot().written == "echo hi\r"
	})
}

func TestResizeControlFrameResizesTheSession(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)
	c.sendControl(`{"type":"resize","payload":{"cols":120,"rows":40}}`)

	eventually(t, "the resize to reach the session", func() bool {
		resizes := terminals.snapshot().resizes
		return len(resizes) == 1 && resizes[0] == dimension{cols: 120, rows: 40}
	})
}

// Closing is an explicit act, and it has to end the child rather than only the
// socket — a "close this tab" that left a shell running would leak a process per
// tab for the life of the app.
func TestCloseControlFrameEndsTheSessionAndTheConnection(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)
	c.sendControl(`{"type":"close"}`)

	frame := c.readEnvelope()
	if frame.Type != typeExit {
		t.Fatalf("frame type = %q, want %q", frame.Type, typeExit)
	}
	// The PTY service reports -1 for a child terminated by a signal, which is
	// what killing a session does.
	if frame.Payload.Code != -1 {
		t.Errorf("exit code = %d, want -1 for a killed child", frame.Payload.Code)
	}

	kills := terminals.snapshot().kills
	if kills != 1 {
		t.Errorf("kills = %d, want exactly 1", kills)
	}
	c.expectNormalClosure()
}

// The transport must not end a session the user did not end. A webview reload,
// a crashed renderer and a project-tab switch all close the socket, and the
// shell has to still be there afterwards (DESIGN.md §3.2).
func TestClosingTheSocketDetachesWithoutKillingTheSession(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)
	if err := c.ws.Close(); err != nil {
		t.Fatalf("closing the socket: %v", err)
	}

	// The detach is the half that is easy to omit: without it the session keeps a
	// queue for a consumer that is never coming back, once per reconnect.
	eventually(t, "the attachment to be released", func() bool {
		return terminals.snapshot().detaches == 1
	})

	kills := terminals.snapshot().kills
	if kills != 0 {
		t.Errorf("kills = %d, want 0 — closing a socket must not end the session", kills)
	}
}

// A session that ends on its own reports its status and closes cleanly.
func TestChildExitIsReportedThenTheSocketClosesCleanly(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)
	terminals.session().output(t, []byte("goodbye\n"))
	if got := string(c.readBinary()); got != "goodbye\n" {
		t.Fatalf("frame = %q, want the last output before the exit", got)
	}

	terminals.session().exit(0)

	frame := c.readEnvelope()
	if frame.Type != typeExit || frame.Payload.Code != 0 {
		t.Errorf("frame = %+v, want an exit with code 0", frame)
	}
	c.expectNormalClosure()
}

// The protocol has to be able to grow. A backend that dropped the connection on
// a message it did not recognize would make every frontend change a lockstep
// release.
func TestUnreadableAndUnknownControlFramesAreIgnored(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)
	c.sendControl(`this is not json`)
	c.sendControl(`{"type":"teleport","payload":{"cols":1}}`)
	c.sendControl(`{"type":"resize","payload":{"cols":100,"rows":30}}`)

	// The resize arriving proves the connection survived both bad frames.
	eventually(t, "the connection to survive and apply the valid frame", func() bool {
		resizes := terminals.snapshot().resizes
		return len(resizes) == 1 && resizes[0] == dimension{cols: 100, rows: 30}
	})
}

// A control frame naming a session that has gone is the end of the connection:
// there is nothing left for it to carry.
func TestResizingAVanishedSessionClosesTheConnection(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)

	terminals.mu.Lock()
	delete(terminals.sessions, fakeSessionID)
	terminals.mu.Unlock()

	c.sendControl(`{"type":"resize","payload":{"cols":80,"rows":24}}`)
	c.expectClosed()
}

// Input for a session that has gone ends the connection for the same reason.
func TestWritingToAVanishedSessionClosesTheConnection(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)

	terminals.mu.Lock()
	delete(terminals.sessions, fakeSessionID)
	terminals.mu.Unlock()

	c.sendBinary([]byte("x"))
	c.expectClosed()
}

// The forwarder must be able to tell a detach from an exit. Both close the
// output channel; only an exit publishes a status, and reporting one for a
// detach would tell every other consumer a live shell had died.
func TestDetachingWithoutAnExitReportsNothing(t *testing.T) {
	terminals := newFakeTerminals()
	server, endpoint := startTestServer(t, terminals)

	c := dial(t, endpoint, "/pty/"+fakeSessionID)
	events := dial(t, endpoint, "/events")

	if err := c.ws.Close(); err != nil {
		t.Fatalf("closing the terminal socket: %v", err)
	}

	eventually(t, "the terminal connection to be unregistered", func() bool {
		server.mu.Lock()
		defer server.mu.Unlock()
		return len(server.conns) == 1
	})

	// The event channel is still open and must have seen nothing. Reading with a
	// short deadline is the only way to assert an absence.
	if err := events.ws.SetReadDeadline(shortDeadline()); err != nil {
		t.Fatalf("setting a read deadline: %v", err)
	}
	_, data, err := events.ws.ReadMessage()
	if err == nil {
		t.Errorf("the event channel received %q; a detach is not an exit", data)
		return
	}
	var closeErr *websocket.CloseError
	if errors.As(err, &closeErr) {
		t.Errorf("the event channel closed with %v; it should still be open", closeErr)
	}
}

// A refused upgrade has to release the attachment it took to answer the request.
// Attaching before upgrading is what turns an unknown session into a 404, and
// the cost of that order is this cleanup.
func TestAnUpgradeRefusedAfterAttachingReleasesTheAttachment(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	// A valid token with a disallowed origin: the token check and the attach both
	// pass, and the upgrade is what refuses.
	status := handshakeStatus(t, endpoint, "/pty/"+fakeSessionID, map[string]string{
		"Authorization": bearerPrefix + endpoint.Token,
		"Origin":        "https://example.com",
	})
	if status != 403 {
		t.Fatalf("handshake status = %d, want 403", status)
	}

	eventually(t, "the attachment taken before the refused upgrade to be released", func() bool {
		return terminals.snapshot().detaches == 1
	})
}
