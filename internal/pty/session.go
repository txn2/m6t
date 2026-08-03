package pty

import (
	"bytes"
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"

	xpty "github.com/aymanbagabas/go-pty"
)

// consumer is one attached reader's delivery queue.
type consumer struct {
	chunks chan []byte
	exited chan Exit
}

// session is one running PTY and the child process attached to it.
type session struct {
	pty xpty.Pty
	cmd *xpty.Cmd

	// done closes when the child has been reaped and the exit status
	// published. Waiting on it is how kill knows there is no process left.
	done chan struct{}

	mu         sync.Mutex
	scrollback *ring
	consumers  []*consumer
	exited     bool
	exit       Exit
}

// start opens a PTY and launches opts.Command in it, or the user's login shell
// when no command is given. The returned session is live but not yet pumping
// output; the caller starts run.
func start(opts Options) (*session, error) {
	terminal, err := xpty.New()
	if err != nil {
		return nil, fmt.Errorf("opening pty: %w", err)
	}

	// Size before starting so the child reads the right geometry from its
	// first prompt onward rather than drawing once at the wrong width.
	cols, rows := size(opts.Cols, opts.Rows)
	if err := terminal.Resize(int(cols), int(rows)); err != nil {
		_ = terminal.Close()
		return nil, fmt.Errorf("sizing pty: %w", err)
	}

	argv := opts.Command
	if len(argv) == 0 {
		argv = shellFor(runtime.GOOS, os.Getenv)
	}

	cmd := terminal.Command(argv[0], argv[1:]...)
	cmd.Dir = opts.Cwd
	cmd.Env = environ(opts.Env)
	if err := cmd.Start(); err != nil {
		_ = terminal.Close()
		return nil, fmt.Errorf("starting %q: %w", argv[0], err)
	}

	return &session{
		pty:        terminal,
		cmd:        cmd,
		done:       make(chan struct{}),
		scrollback: newRing(scrollbackBytes),
	}, nil
}

// run pumps output until the child exits, then publishes the exit status. It
// owns the session's lifetime and returns only once the child is reaped.
func (s *session) run() {
	defer close(s.done)

	drained := make(chan struct{})
	go func() {
		defer close(drained)
		s.pump()
	}()

	waitErr := s.cmd.Wait()

	// The child is gone, but output it wrote before exiting may still be in
	// the pipe. Give the pump a moment to see EOF on its own so that last
	// screenful reaches consumers ahead of the exit event; close the master
	// only if something downstream is holding the slave end open.
	select {
	case <-drained:
	case <-time.After(drainGrace):
	}
	_ = s.pty.Close()
	<-drained

	s.finish(exitStatus(s.cmd, waitErr))
}

// pump reads the PTY master until it fails, which is how a closed or
// hung-up terminal reports that there is nothing more to read.
func (s *session) pump() {
	buf := make([]byte, readChunkBytes)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			s.broadcast(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// broadcast records a chunk in the scrollback and offers it to every attached
// consumer. A consumer whose queue is full has the chunk dropped: the child
// must never wait on a reader.
func (s *session) broadcast(chunk []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.scrollback.write(chunk)
	if len(s.consumers) == 0 {
		return
	}

	// pump reuses its read buffer, so consumers get a copy. One copy is
	// shared across them because nothing downstream may modify it.
	out := bytes.Clone(chunk)
	for _, c := range s.consumers {
		select {
		case c.chunks <- out:
		default:
		}
	}
}

// finish publishes the exit status to every attached consumer and marks the
// session as ended, so later attaches report the status instead of waiting for
// output that will never come.
func (s *session) finish(e Exit) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.exited, s.exit = true, e
	for _, c := range s.consumers {
		close(c.chunks)
		c.exited <- e
		close(c.exited)
	}
	s.consumers = nil
}

// attach registers a consumer and returns its view of the session. The
// scrollback snapshot and the registration happen under one lock, so no chunk
// is both replayed and delivered, and none is missed between the two.
func (s *session) attach() Attachment {
	s.mu.Lock()
	defer s.mu.Unlock()

	c := &consumer{
		chunks: make(chan []byte, consumerQueue),
		exited: make(chan Exit, 1),
	}
	if s.exited {
		close(c.chunks)
		c.exited <- s.exit
		close(c.exited)
	} else {
		s.consumers = append(s.consumers, c)
	}

	return Attachment{Replay: s.scrollback.snapshot(), Chunks: c.chunks, Exited: c.exited}
}

// write sends input to the child.
func (s *session) write(p []byte) error {
	if _, err := s.pty.Write(p); err != nil {
		return fmt.Errorf("writing to pty: %w", err)
	}
	return nil
}

// resize changes the window size the child sees.
func (s *session) resize(cols, rows uint16) error {
	if err := s.pty.Resize(int(cols), int(rows)); err != nil {
		return fmt.Errorf("resizing pty: %w", err)
	}
	return nil
}

// kill terminates the child and returns once it has been reaped, so a caller
// that returns has left no process behind.
//
// A hangup goes first: that is what closing a terminal window does, and it
// gives the shell its chance to run exit traps. A shell that is still alive
// after killGrace gets SIGKILL. Signal errors are not reported because the
// only ordinary cause is the child having already exited, which is the
// outcome being asked for.
func (s *session) kill() {
	if proc := s.cmd.Process; proc != nil {
		_ = hangup(proc)
		select {
		case <-s.done:
			return
		case <-time.After(killGrace):
		}
		_ = forceKill(proc)
	}
	<-s.done
}

// exitStatus reads the child's status off the finished command. A child killed
// by a signal has no exit code of its own, and ExitCode reports -1 for it,
// which is the value Exit documents for that case.
func exitStatus(cmd *xpty.Cmd, waitErr error) Exit {
	if cmd.ProcessState != nil {
		return Exit{Code: cmd.ProcessState.ExitCode()}
	}
	if waitErr != nil {
		return Exit{Code: -1}
	}
	return Exit{Code: 0}
}
