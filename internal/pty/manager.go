package pty

import (
	"fmt"
	"strconv"
	"sync"
)

// Manager owns the live PTY sessions. m6t holds one for the whole
// application: PTYs are backend-owned and survive project-tab switches
// (DESIGN.md §3.2), so their lifetime is the app's, not any window's.
//
// A Manager is safe for concurrent use.
type Manager struct {
	mu       sync.Mutex
	sessions map[SessionID]*session
	lastID   uint64
}

// New returns a Manager holding no sessions.
func New() *Manager {
	return &Manager{sessions: make(map[SessionID]*session)}
}

// Create starts a session and returns its identifier. The session runs until
// its child exits, and stays registered after that until Kill or Shutdown
// drops it.
func (m *Manager) Create(opts Options) (SessionID, error) {
	s, err := start(opts)
	if err != nil {
		return "", err
	}

	m.mu.Lock()
	m.lastID++
	id := SessionID("pty-" + strconv.FormatUint(m.lastID, 10))
	m.sessions[id] = s
	m.mu.Unlock()

	go s.run()

	return id, nil
}

// Attach returns a consumer's view of a session: its scrollback, its
// subsequent output and its exit status.
func (m *Manager) Attach(id SessionID) (Attachment, error) {
	s, err := m.lookup(id)
	if err != nil {
		return Attachment{}, err
	}
	return s.attach(), nil
}

// Write sends input to a session's child.
func (m *Manager) Write(id SessionID, p []byte) error {
	s, err := m.lookup(id)
	if err != nil {
		return err
	}
	return s.write(p)
}

// Resize changes the window size a session's child sees. A zero dimension is
// replaced by the default rather than passed through, because a terminal of
// zero columns is not a size any child can render at.
func (m *Manager) Resize(id SessionID, cols, rows uint16) error {
	s, err := m.lookup(id)
	if err != nil {
		return err
	}
	width, height := size(cols, rows)
	return s.resize(width, height)
}

// Kill terminates a session's child and forgets the session. It returns once
// the child has been reaped. Killing an already-exited session is valid and
// simply drops it.
func (m *Manager) Kill(id SessionID) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("session %s: %w", id, ErrNoSuchSession)
	}
	s.kill()
	return nil
}

// Shutdown terminates every session and returns once they have all been
// reaped. It is what the application calls on the way out, and the reason
// closing m6t does not leave orphaned shells behind.
//
// Sessions are killed concurrently: each one may wait out killGrace, and
// serializing that would multiply the app's shutdown time by the number of
// open terminals.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	live := make([]*session, 0, len(m.sessions))
	for id, s := range m.sessions {
		live = append(live, s)
		delete(m.sessions, id)
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(len(live))
	for _, s := range live {
		go func() {
			defer wg.Done()
			s.kill()
		}()
	}
	wg.Wait()
}

// lookup resolves an identifier to its session.
func (m *Manager) lookup(id SessionID) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("session %s: %w", id, ErrNoSuchSession)
	}
	return s, nil
}
