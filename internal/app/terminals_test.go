package app

import (
	"errors"
	"testing"

	"github.com/txn2/m6t/internal/pty"
)

// The bridge is pure translation, and the thing translation gets wrong is
// errors: a method that swallowed one would leave the stream server treating a
// vanished session as a live one, streaming into nothing.
//
// The error has to stay identifiable through the wrapping, because that is how
// the layers above tell "no such session" from a real failure.
func TestTheTerminalBridgeReportsAnUnknownSessionFromEveryMethod(t *testing.T) {
	bridge := terminalBridge{terminals: pty.New()}
	const missing = "pty-does-not-exist"

	tests := map[string]func() error{
		"Attach": func() error {
			_, err := bridge.Attach(missing)
			return err
		},
		"Write":  func() error { return bridge.Write(missing, []byte("x")) },
		"Resize": func() error { return bridge.Resize(missing, 80, 24) },
		"Kill":   func() error { return bridge.Kill(missing) },
	}

	for name, call := range tests {
		t.Run(name, func(t *testing.T) {
			err := call()
			if err == nil {
				t.Fatalf("%s on an unknown session returned no error", name)
			}
			if !errors.Is(err, pty.ErrNoSuchSession) {
				t.Errorf("%s error = %v, want it to wrap ErrNoSuchSession", name, err)
			}
		})
	}
}
