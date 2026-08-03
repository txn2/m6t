// Package pty owns the pseudo-terminal sessions behind m6t's embedded
// terminal (DESIGN.md §3.2, §8). It spawns the user's real login shell
// attached to a real PTY, keeps a bounded scrollback per session, and hands
// output to whichever consumers are attached.
//
// The package knows nothing about transports, terminal tabs or the Wails
// bridge. It takes an argv slice and a window size and returns an identifier;
// the loopback stream server and the UI are built on top of that seam rather
// than inside it, which is what lets either change without touching process
// lifecycle.
//
// Ownership contract: a session outlives its child process. When the child
// exits, the session records the status, notifies attached consumers and stops
// producing output, but stays registered so a consumer can still attach and
// replay the final scrollback — the "your shell exited" state a terminal tab
// shows. The owner drops the session with Kill, and Shutdown drops all of
// them. Nothing else removes a session from a Manager.
package pty

import (
	"errors"
	"os"
	"time"
)

const (
	// defaultCols and defaultRows size a session whose caller did not say.
	// They are the classic terminal geometry, chosen because a shell that
	// starts at 0x0 renders its prompt at the wrong width until the first
	// resize arrives.
	defaultCols = 80
	defaultRows = 24

	// scrollbackBytes bounds the per-session replay buffer. It is what a
	// consumer attaching late receives, and it is the reason a session with
	// nobody reading it cannot grow without limit.
	scrollbackBytes = 256 << 10

	// readChunkBytes sizes one read from the PTY master. Large enough that a
	// screenful of output arrives in one chunk, small enough that the first
	// byte of a prompt is not held back waiting for a full buffer.
	readChunkBytes = 32 << 10

	// consumerQueue is how many chunks a single consumer may fall behind
	// before its chunks start being dropped. Dropping is deliberate: the
	// alternative is back-pressure onto the shell, which would let a stalled
	// WebSocket freeze the user's terminal.
	consumerQueue = 64

	// killGrace is how long a child gets between the hangup and the SIGKILL.
	// It is the window in which a shell runs its exit traps and flushes; a
	// shell that ignores the hangup does not get to hold up app shutdown.
	killGrace = 2 * time.Second

	// drainGrace bounds the wait for the output pump to see EOF after the
	// child exits. Normally EOF arrives immediately; a grandchild still
	// holding the slave end open is what this timeout exists for.
	drainGrace = 250 * time.Millisecond

	// terminalType is the TERM the child sees. xterm.js implements the
	// xterm-256color capabilities (DESIGN.md §8), so claiming anything else
	// would misreport what the frontend can render.
	terminalType = "xterm-256color"

	// windowsGOOS is the runtime.GOOS value for Windows.
	windowsGOOS = "windows"
)

// ErrNoSuchSession reports an operation naming a session the Manager does not
// hold — one never created, or one already killed.
var ErrNoSuchSession = errors.New("no such pty session")

// SessionID identifies one session within a Manager. It is opaque: callers
// pass it back, they do not parse it.
type SessionID string

// Options describes a session to create. The zero value is valid and starts
// the user's login shell at the default size in the process's own working
// directory.
type Options struct {
	// Cwd is the child's working directory. Empty means inherit the
	// application's.
	Cwd string

	// Env holds additional environment entries in "KEY=value" form. They are
	// appended to the application's own environment, so a caller can override
	// an inherited variable by naming it again.
	Env []string

	// Cols and Rows are the initial window size. Zero means the default.
	Cols uint16
	Rows uint16

	// Command is the argv to run. Empty means the user's login shell, which
	// is what a terminal tab wants; the project's "run Claude Code" action
	// (DESIGN.md §6) is what passes an explicit argv.
	Command []string
}

// Exit reports how a session's child process ended.
type Exit struct {
	// Code is the child's exit status, or -1 when it was terminated by a
	// signal rather than exiting on its own. -1 is what a killed session
	// reports on every platform, which is why the signal number is not
	// carried here: it has no meaning on Windows.
	Code int
}

// Attachment is one consumer's view of a session: what the session has already
// produced, what it produces next, and how it ended.
type Attachment struct {
	// Replay is the scrollback at the moment of attaching — up to
	// scrollbackBytes of the most recent output. It is a fresh copy the
	// consumer owns.
	Replay []byte

	// Chunks carries output produced after the attach. It is closed when the
	// child exits.
	//
	// A consumer that stops reading does not stall the child: once it is
	// consumerQueue chunks behind, further chunks are dropped rather than
	// queued. Dropping loses bytes in the middle of the stream, so a consumer
	// that cares about rendering fidelity — a terminal does — should treat a
	// resumed read as a reason to redraw from a fresh Attach rather than
	// assume continuity.
	//
	// Chunks are read-only and shared: every consumer of the same session
	// receives the same backing array for a given chunk. Modifying one would
	// corrupt what the others see.
	Chunks <-chan []byte

	// Exited receives the exit status exactly once and is then closed.
	// Attaching to an already-exited session yields a channel that already
	// holds the status, so a late consumer never blocks here.
	Exited <-chan Exit

	// Detach unregisters the consumer. Both channels close and nothing further
	// is delivered; a consumer ranging over Chunks sees the range end and
	// Exited yield nothing, which is how it tells a detach from a real exit.
	//
	// Calling it is not optional for a consumer that goes away before its
	// session does. A consumer left registered keeps its queue — up to
	// consumerQueue chunks of scrollback — alive for the rest of the session's
	// life, so one terminal that reconnects repeatedly would accumulate them.
	// Detach is idempotent and safe to call on an already-exited session.
	Detach func()
}

// shellFor returns the argv of the user's login shell for the named platform.
//
// The environment lookup and GOOS are parameters rather than reads of the
// ambient process so this decision is testable for every platform from any
// platform — the alternative is a rule that only the machine running the test
// ever exercises.
func shellFor(goos string, lookupEnv func(string) string) []string {
	if goos == windowsGOOS {
		return []string{"powershell.exe"}
	}
	if shell := lookupEnv("SHELL"); shell != "" {
		return []string{shell}
	}
	return []string{"/bin/sh"}
}

// environ builds the child's environment: everything the application has, then
// TERM, then the caller's additions. Later entries win, so a caller can
// override TERM and TERM overrides an inherited one.
func environ(extra []string) []string {
	env := os.Environ()
	env = append(env, "TERM="+terminalType)
	return append(env, extra...)
}

// size resolves the requested window size, substituting the default for a
// dimension the caller left at zero.
func size(cols, rows uint16) (width, height uint16) {
	if cols == 0 {
		cols = defaultCols
	}
	if rows == 0 {
		rows = defaultRows
	}
	return cols, rows
}
