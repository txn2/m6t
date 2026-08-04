package app

import (
	"fmt"

	"github.com/txn2/m6t/internal/pty"
	"github.com/txn2/m6t/internal/stream"
)

// terminalOptions translates a terminal tab's request into the PTY service's
// options.
//
// It is a function rather than a struct literal inside OpenTerminal so that the
// mapping — which argument lands in which field — is pinned by a test. The
// alternative is asking a live shell what size it thinks it is, which is a
// flaky test of pty's job rather than a direct test of this one.
//
// Command stays empty deliberately: a terminal tab is the user's login shell,
// and no argv crosses the Wails bridge (see App.OpenTerminal).
func terminalOptions(cwd string, cols, rows uint16) pty.Options {
	return pty.Options{Cwd: cwd, Cols: cols, Rows: rows}
}

// terminalBridge presents the PTY service through the seam the stream server
// declares.
//
// The two are sibling backend services and must not import each other — that
// rule is what keeps either one replaceable, and depguard enforces it — so
// neither can name the other's session identifier or attachment type. The
// binding layer is the one place that knows about both, so the adaptation lives
// here. It is deliberately nothing but translation: no policy, no state.
type terminalBridge struct {
	terminals *pty.Manager
}

// Attach hands the stream server a consumer's view of a session.
func (b terminalBridge) Attach(id string) (stream.Attachment, error) {
	attachment, err := b.terminals.Attach(pty.SessionID(id))
	if err != nil {
		return stream.Attachment{}, fmt.Errorf("attaching to terminal %s: %w", id, err)
	}
	return stream.Attachment{
		Replay: attachment.Replay,
		Chunks: attachment.Chunks,
		Exited: exitCodes(attachment.Exited),
		Detach: attachment.Detach,
	}, nil
}

// Write sends client input to a session's child.
func (b terminalBridge) Write(id string, p []byte) error {
	if err := b.terminals.Write(pty.SessionID(id), p); err != nil {
		return fmt.Errorf("writing to terminal %s: %w", id, err)
	}
	return nil
}

// Resize changes the window size a session's child sees.
func (b terminalBridge) Resize(id string, cols, rows uint16) error {
	if err := b.terminals.Resize(pty.SessionID(id), cols, rows); err != nil {
		return fmt.Errorf("resizing terminal %s: %w", id, err)
	}
	return nil
}

// Kill ends a session and its child.
func (b terminalBridge) Kill(id string) error {
	if err := b.terminals.Kill(pty.SessionID(id)); err != nil {
		return fmt.Errorf("killing terminal %s: %w", id, err)
	}
	return nil
}

// exitCodes narrows the PTY service's exit status to the code the stream
// protocol carries.
//
// The forwarding goroutine ends when the source channel closes, which the PTY
// service does after publishing at most one status — so it neither leaks nor
// outlives the session. Closing the output channel without a value is how a
// detach reaches the reader, and the stream server relies on that distinction.
func exitCodes(exits <-chan pty.Exit) <-chan int {
	codes := make(chan int, 1)
	go func() {
		defer close(codes)
		for exit := range exits {
			codes <- exit.Code
		}
	}()
	return codes
}
