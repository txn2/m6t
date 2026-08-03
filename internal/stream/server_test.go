package stream

import (
	"errors"
	"strings"
	"testing"
)

func TestEndpointFailsBeforeTheListenerIsUp(t *testing.T) {
	server := New(newFakeTerminals())

	if _, err := server.Endpoint(); !errors.Is(err, errNotStarted) {
		t.Errorf("Endpoint() error = %v, want errNotStarted", err)
	}
}

func TestStartedServerReportsItsRealPortAndToken(t *testing.T) {
	_, endpoint := startTestServer(t, newFakeTerminals())

	if endpoint.Port <= 0 {
		t.Errorf("Port = %d, want the port the listener actually got", endpoint.Port)
	}
	if endpoint.Token == "" {
		t.Error("Token is empty; every connection has to present one")
	}
}

// The token is per launch. Two servers sharing one would mean a token learned
// from a previous run still worked, which is the whole reason it is minted at
// construction rather than configured.
func TestEachServerMintsItsOwnToken(t *testing.T) {
	_, first := startTestServer(t, newFakeTerminals())
	_, second := startTestServer(t, newFakeTerminals())

	if first.Token == second.Token {
		t.Error("two servers minted the same token")
	}
	if first.Port == second.Port {
		t.Errorf("two servers bound the same port %d; both must run side by side", first.Port)
	}
}

// A bind failure has to reach the frontend. Logging it would put the reason
// somewhere the user is not looking, and returning errNotStarted would say the
// server had not been started yet when in fact it never will be.
func TestABindFailureIsReportedThroughEndpoint(t *testing.T) {
	server := New(newFakeTerminals())

	// Port 70000 is outside the 16-bit port space, so the bind fails without
	// depending on what else is listening on the machine.
	startErr := server.listenAndServe("127.0.0.1:70000")
	if startErr == nil {
		t.Fatal("binding an out-of-range port succeeded")
	}

	_, err := server.Endpoint()
	if err == nil {
		t.Fatal("Endpoint() succeeded after the listener failed to bind")
	}
	if errors.Is(err, errNotStarted) {
		t.Error("Endpoint() reported errNotStarted; it must carry the bind failure instead")
	}
	if !strings.Contains(err.Error(), "binding the stream server") {
		t.Errorf("Endpoint() error = %v, want it to carry the bind failure", err)
	}
}

func TestStartingATwiceStartedServerIsRefused(t *testing.T) {
	server, endpoint := startTestServer(t, newFakeTerminals())

	err := server.Start()
	if err == nil {
		t.Fatal("a second Start succeeded; it would leak the first listener")
	}
	if !strings.Contains(err.Error(), "already serving") {
		t.Errorf("second Start error = %v, want it to say the server is already serving", err)
	}

	// The first listener is untouched, which is the point of refusing.
	again, err := server.Endpoint()
	if err != nil {
		t.Fatalf("Endpoint() after a refused restart: %v", err)
	}
	if again != endpoint {
		t.Errorf("Endpoint() = %+v, want the original %+v", again, endpoint)
	}
}

// Upgraded connections are hijacked, so http.Server.Shutdown neither waits for
// them nor closes them. Shutdown has to close them itself or quitting the app
// would hang on a live terminal.
func TestShutdownClosesLiveConnections(t *testing.T) {
	terminals := newFakeTerminals()
	server, endpoint := startTestServer(t, terminals)

	terminal := dial(t, endpoint, "/pty/"+fakeSessionID)
	events := dial(t, endpoint, "/events")

	server.Shutdown()

	terminal.expectClosed()
	events.expectClosed()

	server.mu.Lock()
	live := len(server.conns)
	server.mu.Unlock()
	if live != 0 {
		t.Errorf("%d connections still registered after shutdown, want 0", live)
	}

	// The sessions themselves are the PTY service's to end, not the transport's.
	if kills := terminals.snapshot().kills; kills != 0 {
		t.Errorf("kills = %d, want 0 — the stream server does not end sessions", kills)
	}
}

func TestShutdownIsSafeBeforeStartAndTwice(t *testing.T) {
	server := New(newFakeTerminals())
	server.Shutdown()

	if err := server.Start(); err != nil {
		t.Fatalf("starting after a shutdown that never had a listener: %v", err)
	}
	server.Shutdown()
	server.Shutdown()
}

// A shut-down server has no endpoint to give out: handing over a port that is no
// longer listening would send the frontend at a socket that cannot answer.
func TestEndpointFailsAfterShutdown(t *testing.T) {
	server := New(newFakeTerminals())
	if err := server.Start(); err != nil {
		t.Fatalf("starting the stream server: %v", err)
	}
	server.Shutdown()

	if _, err := server.Endpoint(); err == nil {
		t.Error("Endpoint() succeeded after shutdown")
	}
}
