package stream

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
)

// Control and event type names. These are wire constants: PROTOCOL.md is the
// specification and the frontend reads it, so renaming one here is a protocol
// change, not a refactor.
const (
	// typeResize asks the child to be told a new window size.
	typeResize = "resize"

	// typeClose ends the session and its child. Closing the socket does not:
	// PTYs survive tab switches (DESIGN.md §3.2), so ending one is an explicit
	// act.
	typeClose = "close"

	// typeExit reports the child's exit status.
	typeExit = "exit"

	// typeResync reports that output was dropped, so a renderer knows its view
	// is no longer a faithful replay of the stream.
	typeResync = "resync"
)

// envelope is the JSON text frame both endpoints speak: a type and its payload.
// The /events channel uses the same shape so a consumer has one decoder for
// backend-push events and terminal control frames alike.
type envelope struct {
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
}

// exitPayload carries a child's exit status. -1 is what the PTY service reports
// for a child killed by a signal.
type exitPayload struct {
	Code int `json:"code"`
}

// resyncPayload carries how much output was discarded since the last marker.
type resyncPayload struct {
	DroppedBytes int64 `json:"droppedBytes"`
}

// control is an inbound text frame. Only the fields the server acts on are
// declared: an unknown type or an absent payload decodes to the zero value and
// is ignored rather than closing the connection.
type control struct {
	Type    string `json:"type"`
	Payload struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	} `json:"payload"`
}

// requestToken extracts the bearer token a request presents, in either
// supported form, or "" when it presents none.
//
// The Authorization header wins when present: a client that can set headers has
// no reason to use the subprotocol form, and preferring the header keeps a
// stale subprotocol from overriding an explicit credential.
func requestToken(r *http.Request) string {
	if header := r.Header.Get("Authorization"); header != "" {
		if token, ok := strings.CutPrefix(header, bearerPrefix); ok {
			return token
		}
		return ""
	}
	for _, offered := range websocket.Subprotocols(r) {
		if token, ok := strings.CutPrefix(offered, authSubprotocolPrefix); ok {
			return token
		}
	}
	return ""
}

// originAllowed reports whether a request's Origin may open a socket.
//
// An absent Origin passes: browsers always send one, so a request without it is
// a non-browser client that could have made a plain HTTP request to the same
// port anyway — the token is what defends that case. Everything else must be
// the Wails webview or loopback; in particular "null", which is what a file://
// document and a sandboxed frame report, is refused.
func originAllowed(origin string) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if parsed.Scheme == wailsScheme {
		return true
	}
	host := parsed.Hostname()
	if host == localhostHost || host == wailsHost {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}
