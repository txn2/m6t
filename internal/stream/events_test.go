package stream

import (
	"slices"
	"testing"
)

// A PTY exit goes to the event channel as well as to the terminal socket: a tab
// renders it, and the rest of the UI learns a session ended without having to be
// attached to it.
func TestSessionExitIsPublishedToEveryEventSubscriber(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	first := dial(t, endpoint, "/events")
	second := dial(t, endpoint, "/events")
	terminal := dial(t, endpoint, "/pty/"+fakeSessionID)

	// The terminal socket has to be attached before the session ends, or there is
	// no forwarder to publish the exit.
	terminals.session().output(t, []byte("bye\n"))
	if got := string(terminal.readBinary()); got != "bye\n" {
		t.Fatalf("terminal frame = %q, want the output before the exit", got)
	}

	terminals.session().exit(3)

	for name, subscriber := range map[string]*client{"first": first, "second": second} {
		frame := subscriber.readEnvelope()
		if frame.Type != typeExit {
			t.Errorf("%s subscriber received type %q, want %q", name, frame.Type, typeExit)
		}
		if frame.Payload.Code != 3 {
			t.Errorf("%s subscriber received code %d, want 3", name, frame.Payload.Code)
		}
	}
}

// PublishTree is internal/watch's entry point into the event channel: a
// producer other than a terminal connection can announce a change and every
// /events subscriber sees it, the same as a PTY exit does.
func TestPublishTreeIsPublishedToEveryEventSubscriber(t *testing.T) {
	terminals := newFakeTerminals()
	server, endpoint := startTestServer(t, terminals)

	first := dial(t, endpoint, "/events")
	second := dial(t, endpoint, "/events")

	server.PublishTree("/repo", []string{".", "manifests"})

	for name, subscriber := range map[string]*client{"first": first, "second": second} {
		frame := subscriber.readEnvelope()
		if frame.Type != typeTree {
			t.Errorf("%s subscriber received type %q, want %q", name, frame.Type, typeTree)
		}
		if frame.Payload.Root != "/repo" {
			t.Errorf("%s subscriber received root %q, want %q", name, frame.Payload.Root, "/repo")
		}
		if want := []string{".", "manifests"}; !slices.Equal(frame.Payload.Dirs, want) {
			t.Errorf("%s subscriber received dirs %v, want %v", name, frame.Payload.Dirs, want)
		}
	}
}

// A terminal connection is not registered for events (the same guarantee
// TestPublishingWithNoSubscribersIsHarmless covers for exit), so a tree
// change must never arrive on one.
func TestPublishTreeDoesNotReachTerminalConnections(t *testing.T) {
	terminals := newFakeTerminals()
	server, endpoint := startTestServer(t, terminals)

	terminal := dial(t, endpoint, "/pty/"+fakeSessionID)
	server.PublishTree("/repo", []string{"."})

	// The session ending is what unblocks the read below without a tree frame
	// ever having to (not) arrive on its own timeout.
	terminals.session().exit(0)
	if frame := terminal.readEnvelope(); frame.Type != typeExit {
		t.Fatalf("terminal frame type = %q, want %q — a tree event must not reach a terminal socket", frame.Type, typeExit)
	}
}

// The event channel is push-only. Anything a client sends is discarded rather
// than treated as a protocol error, because a client has no reason to send and a
// disconnect is not the right answer to one that does.
func TestTheEventChannelDiscardsClientInput(t *testing.T) {
	terminals := newFakeTerminals()
	_, endpoint := startTestServer(t, terminals)

	events := dial(t, endpoint, "/events")
	events.sendControl(`{"type":"close"}`)
	events.sendBinary([]byte("nonsense"))

	// The channel still works, which is the proof it was not closed or confused
	// by the input above.
	terminal := dial(t, endpoint, "/pty/"+fakeSessionID)
	terminals.session().output(t, []byte("x"))
	if got := string(terminal.readBinary()); got != "x" {
		t.Fatalf("terminal frame = %q, want the session output", got)
	}
	terminals.session().exit(0)

	if frame := events.readEnvelope(); frame.Type != typeExit {
		t.Errorf("event type = %q, want %q", frame.Type, typeExit)
	}
	kills := terminals.snapshot().kills
	if kills != 0 {
		t.Errorf("kills = %d, want 0 — a control frame on /events must not act on a session", kills)
	}
}

// Publishing must not depend on anyone listening, and a terminal socket must not
// receive events: it carries one session's stream, and an event envelope
// arriving there would be a second exit frame for the same session.
func TestPublishingWithNoSubscribersIsHarmless(t *testing.T) {
	terminals := newFakeTerminals()
	server, endpoint := startTestServer(t, terminals)

	terminal := dial(t, endpoint, "/pty/"+fakeSessionID)
	terminals.session().exit(0)

	// One exit frame on the terminal socket, from the forwarder — not two.
	if frame := terminal.readEnvelope(); frame.Type != typeExit {
		t.Fatalf("frame type = %q, want %q", frame.Type, typeExit)
	}
	terminal.expectNormalClosure()

	// And the publish itself reached no one, because a terminal connection is not
	// registered as an event subscriber.
	server.mu.Lock()
	defer server.mu.Unlock()
	for c, wantsEvents := range server.conns {
		if wantsEvents {
			t.Errorf("connection %p is registered for events; only /events subscribes", c)
		}
	}
}
