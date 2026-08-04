package watch

import (
	"fmt"
	"sync"
)

// Options configures a Service.
type Options struct {
	// Poll forces snapshot-diff polling instead of fsnotify for every root
	// this Service starts, for filesystems — network mounts, DESIGN.md
	// §3.2 — where inotify/FSEvents is unreliable.
	Poll bool
}

// stopper is what both watcher kinds (fsWatcher, pollWatcher) implement.
// Service does not care which is running for a given root.
type stopper interface {
	stop()
}

// Service manages the live watchers for every open project's worktree.
//
// One instance covers the whole application, the shape internal/pty's
// Manager already takes for terminal sessions: watchers are backend-owned,
// and their lifetime is tied to a project being registered, not to any
// window or tab (DESIGN.md §3.2).
//
// A Service is safe for concurrent use.
type Service struct {
	events Events
	poll   bool

	mu       sync.Mutex
	watchers map[string]stopper // keyed by root path
}

// New builds a Service that publishes through events. opts.Poll selects
// polling over fsnotify for every root this Service starts.
func New(events Events, opts Options) *Service {
	return &Service{
		events:   events,
		poll:     opts.Poll,
		watchers: make(map[string]stopper),
	}
}

// Start begins watching root. It is idempotent: starting an already-watched
// root is a no-op, which is what lets a caller start watching from both "a
// project was just added" and "the application is starting up with projects
// already registered" without first checking which case it is in.
func (s *Service) Start(root string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.watchers[root]; ok {
		return nil
	}

	w, err := s.newWatcher(root)
	if err != nil {
		return fmt.Errorf("watching %s: %w", root, err)
	}
	s.watchers[root] = w
	return nil
}

// newWatcher starts the configured watcher kind for root. The caller holds
// s.mu.
func (s *Service) newWatcher(root string) (stopper, error) {
	if s.poll {
		return startPollWatcher(root, s.events)
	}
	return startFsWatcher(root, s.events)
}

// Stop ends watching root. Stopping a root that is not watched is a no-op.
func (s *Service) Stop(root string) {
	s.mu.Lock()
	w, ok := s.watchers[root]
	delete(s.watchers, root)
	s.mu.Unlock()

	if ok {
		w.stop()
	}
}

// Shutdown ends every watcher. It is what the application calls on the way
// out.
func (s *Service) Shutdown() {
	s.mu.Lock()
	live := make([]stopper, 0, len(s.watchers))
	for root, w := range s.watchers {
		live = append(live, w)
		delete(s.watchers, root)
	}
	s.mu.Unlock()

	for _, w := range live {
		w.stop()
	}
}
