package stream

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOriginAllowed(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		want   bool
	}{
		// Browsers always send an Origin, so an absent one is a non-browser
		// client and the token is what guards it.
		{name: "absent origin", origin: "", want: true},
		{name: "wails webview on macos and linux", origin: "wails://wails", want: true},
		{name: "wails webview on windows", origin: "http://wails.localhost", want: true},
		{name: "loopback by name", origin: "http://localhost:5173", want: true},
		{name: "loopback by address", origin: "http://127.0.0.1:51234", want: true},
		{name: "loopback in another /8 address", origin: "http://127.9.9.9", want: true},
		{name: "ipv6 loopback", origin: "http://[::1]:51234", want: true},

		// The refusals are the point of the check.
		{name: "opaque origin from a file or sandboxed frame", origin: "null", want: false},
		{name: "another host", origin: "https://example.com", want: false},
		{name: "a host that merely starts with the loopback address", origin: "http://127.0.0.1.example.com", want: false},
		{name: "a host that merely ends with the wails name", origin: "http://evil.wails.localhost", want: false},
		{name: "a private but non-loopback address", origin: "http://10.0.0.1", want: false},
		{name: "a scheme that merely contains wails", origin: "notwails://wails", want: false},
		{name: "an unparseable origin", origin: "http://[::1", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := originAllowed(tt.origin); got != tt.want {
				t.Errorf("originAllowed(%q) = %v, want %v", tt.origin, got, tt.want)
			}
		})
	}
}

func TestRequestTokenReadsBothSupportedForms(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{
			name:    "no credential at all",
			headers: map[string]string{},
			want:    "",
		},
		{
			name:    "bearer header",
			headers: map[string]string{"Authorization": "Bearer SECRET"},
			want:    "SECRET",
		},
		{
			name: "subprotocol form, as a browser must send it",
			headers: map[string]string{
				"Sec-Websocket-Protocol": protocolVersion + ", " + authSubprotocolPrefix + "SECRET",
			},
			want: "SECRET",
		},
		{
			// A header that names a scheme this server does not accept must not
			// fall through to the subprotocol: an explicit credential losing to
			// an implicit one is how a stale token gets used.
			name: "an unsupported authorization scheme yields nothing",
			headers: map[string]string{
				"Authorization":          "Basic dXNlcjpwYXNz",
				"Sec-Websocket-Protocol": authSubprotocolPrefix + "SECRET",
			},
			want: "",
		},
		{
			name: "a subprotocol list with no token entry yields nothing",
			headers: map[string]string{
				"Sec-Websocket-Protocol": protocolVersion,
			},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/events", http.NoBody)
			for name, value := range tt.headers {
				r.Header.Set(name, value)
			}
			if got := requestToken(r); got != tt.want {
				t.Errorf("requestToken() = %q, want %q", got, tt.want)
			}
		})
	}
}

// Every refusal must land as an HTTP status on an un-upgraded connection. A
// server that upgraded first and closed afterwards would leak the existence of
// sessions to an unauthenticated caller and give a browser no readable reason.
func TestConnectionsAreRefusedBeforeTheUpgrade(t *testing.T) {
	server, endpoint := startTestServer(t, newFakeTerminals())

	tests := []struct {
		name    string
		path    string
		headers map[string]string
		want    int
	}{
		{
			name: "no token",
			path: "/pty/" + fakeSessionID,
			want: http.StatusUnauthorized,
		},
		{
			name:    "wrong token",
			path:    "/pty/" + fakeSessionID,
			headers: map[string]string{"Authorization": bearerPrefix + "not-the-token"},
			want:    http.StatusUnauthorized,
		},
		{
			name:    "a token that is a prefix of the real one",
			path:    "/pty/" + fakeSessionID,
			headers: map[string]string{"Authorization": bearerPrefix + endpoint.Token[:len(endpoint.Token)-1]},
			want:    http.StatusUnauthorized,
		},
		{
			name: "no token on the event channel either",
			path: "/events",
			want: http.StatusUnauthorized,
		},
		{
			name: "a disallowed origin, even with the right token",
			path: "/pty/" + fakeSessionID,
			headers: map[string]string{
				"Authorization": bearerPrefix + endpoint.Token,
				"Origin":        "https://example.com",
			},
			want: http.StatusForbidden,
		},
		{
			name:    "an unknown session, with the right token",
			path:    "/pty/does-not-exist",
			headers: map[string]string{"Authorization": bearerPrefix + endpoint.Token},
			want:    http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status := handshakeStatus(t, endpoint, tt.path, tt.headers)
			if status != tt.want {
				t.Errorf("handshake status = %d, want %d", status, tt.want)
			}
			if status == http.StatusSwitchingProtocols {
				t.Error("the connection was upgraded; the refusal must precede the handshake")
			}
		})
	}

	// A refused connection must not be registered, or shutdown would be closing
	// sockets that were never opened.
	server.mu.Lock()
	live := len(server.conns)
	server.mu.Unlock()
	if live != 0 {
		t.Errorf("%d connections registered after only refusals, want 0", live)
	}
}

// The token must be usable in the form a browser is restricted to, and the
// server must select the version subprotocol when it is — a browser fails the
// connection if it offered subprotocols and the server chose none.
func TestBrowserSubprotocolFormIsAcceptedAndVersionNegotiated(t *testing.T) {
	_, endpoint := startTestServer(t, newFakeTerminals())

	client := dialSubprotocol(t, endpoint, "/pty/"+fakeSessionID)
	if got := client.ws.Subprotocol(); got != protocolVersion {
		t.Errorf("negotiated subprotocol = %q, want %q", got, protocolVersion)
	}
}
