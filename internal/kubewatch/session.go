package kubewatch

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// Backoff between reconnection attempts.
//
// It starts short because the common failure is momentary — a watch the API
// server closed on rotation, a laptop that just woke — and a first retry a
// second later usually succeeds. It caps low because the failures that outlast
// the cap are the ones a person is fixing in another window (an expired SSO
// session, a VPN reconnecting), and a panel that took a minute to notice the
// fix would send them to the reload button instead.
const (
	minBackoff = time.Second
	maxBackoff = 15 * time.Second
)

// session is one project's watch: a goroutine holding a connection, and the
// state the panel reads out of it.
//
// The state is guarded by mu and the goroutine is the only writer. Readers are
// bound-method calls arriving on Wails' goroutines, which is why snapshot
// copies rather than handing out the slice it maintains.
type session struct {
	// key is the checkout and the binding, both immutable for this session's
	// life. See sessionKey for why a binding is identity rather than state.
	key sessionKey

	manifests Manifests
	connect   Connector
	events    Events

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	// replanned asks the run loop to rebuild: the binding moved, or the
	// checkout changed. It is buffered by one and written non-blockingly, so a
	// burst of file saves is one rebuild rather than a queue of them.
	replanned chan struct{}

	// dirty asks the announcer to publish. Same shape and the same reason.
	dirty chan struct{}

	mu      sync.Mutex
	phase   Phase
	reason  string
	objects []Status
	notices []Notice
}

// newSession starts a session's goroutines.
func newSession(key sessionKey, manifests Manifests, connect Connector, events Events) *session {
	ctx, cancel := context.WithCancel(context.Background())
	s := &session{
		key:       key,
		manifests: manifests,
		connect:   connect,
		events:    events,
		ctx:       ctx,
		cancel:    cancel,
		done:      make(chan struct{}),
		replanned: make(chan struct{}, 1),
		dirty:     make(chan struct{}, 1),
		phase:     PhaseConnecting,
	}
	go s.run()
	go s.announce()
	return s
}

// replan asks the run loop to rebuild from the current checkout.
func (s *session) replan() {
	select {
	case s.replanned <- struct{}{}:
	default:
	}
}

// stop ends the session and waits for its run loop.
func (s *session) stop() {
	s.cancel()
	<-s.done
}

// snapshot copies the state out for a caller on another goroutine.
func (s *session) snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	objects := make([]Status, len(s.objects))
	copy(objects, s.objects)
	notices := make([]Notice, len(s.notices))
	copy(notices, s.notices)

	return Snapshot{Phase: s.phase, Reason: s.reason, Objects: objects, Notices: notices}
}

// run is the session's lifetime: build, follow, fail, back off, build again.
//
// A cycle returning nil means it was asked to rebuild, which is not a failure
// and resets the backoff — otherwise a user editing manifests during an outage
// would find each save slower to take effect than the last.
func (s *session) run() {
	defer close(s.done)

	backoff := time.Duration(0)
	for s.ctx.Err() == nil {
		if !wait(s.ctx, backoff) {
			return
		}
		err := s.cycle()
		switch {
		case s.ctx.Err() != nil:
			return
		case err == nil:
			backoff = 0
		default:
			s.setPhase(phaseFor(err), err.Error())
			backoff = next(backoff)
		}
	}
}

// next is the backoff schedule: double, capped.
func next(current time.Duration) time.Duration {
	if current == 0 {
		return minBackoff
	}
	if doubled := current * 2; doubled < maxBackoff {
		return doubled
	}
	return maxBackoff
}

// phaseFor decides what a failure looks like to the user.
//
// A refusal is its own phase because it is the one failure that will not fix
// itself: retrying is still right — credentials get renewed — but a panel
// saying "reconnecting" for a session that is being actively denied would send
// the user looking at their network instead of at their login.
func phaseFor(err error) Phase {
	if apierrors.IsUnauthorized(err) || apierrors.IsForbidden(err) {
		return PhaseUnauthorized
	}
	return PhaseReconnecting
}

// cycle builds one connection and follows it until it fails or is superseded.
//
// A nil return means "rebuild": either the caller asked, or there was nothing
// to watch and something changed. An error means the connection failed.
func (s *session) cycle() error {
	objects, notices, err := s.manifests.Declared(s.key.root, s.key.target, s.key.namespace)
	if err != nil {
		return fmt.Errorf("reading what %s declares: %w", s.key.root, err)
	}
	s.setNotices(notices)
	if len(objects) == 0 {
		return s.park("nothing here is declared against this context and namespace")
	}

	s.setPhase(PhaseConnecting, "")
	client, mapper, err := s.connect(s.key.target)
	if err != nil {
		return err
	}

	order, groups := plan(mapper, client, objects, s.key.namespace)
	s.seed(order)
	s.setPhase(PhaseWatching, "")
	return s.follow(groups, objects)
}

// park reports an idle session and waits to be rebuilt, holding no connection.
//
// It is what a checkout with nothing aimed at this binding does. The
// alternative — returning and letting the run loop retry — would be a busy loop
// against a condition only an edit can change.
func (s *session) park(reason string) error {
	s.setPhase(PhaseIdle, reason)
	s.clear()
	select {
	case <-s.replanned:
		return nil
	case <-s.ctx.Done():
		return fmt.Errorf("the watch on %s ended: %w", s.key.root, s.ctx.Err())
	}
}

// follow runs every group until one fails, the plan is superseded, or the
// session ends.
//
// Groups run concurrently and the first failure ends the cycle for all of them,
// which is deliberate: the failures that reach here are the connection's, not
// one resource's, and a session that kept three groups running while a fourth
// retried would report PhaseWatching over objects nobody was watching. The
// per-resource failures that are NOT the connection's — a namespace this user
// cannot read — are handled inside pump and never reach here.
func (s *session) follow(groups []group, planned []Object) error {
	ctx, cancel := context.WithCancel(s.ctx)
	var running sync.WaitGroup
	// Ordered so the cancel runs first and the wait second: reversing them
	// would block shutdown on goroutines that have not been told to stop.
	defer running.Wait()
	defer cancel()

	failed := make(chan error, len(groups))
	for _, g := range groups {
		running.Go(func() { failed <- s.pump(ctx, g) })
	}

	for {
		select {
		case err := <-failed:
			return err
		case <-s.replanned:
			if s.superseded(planned) {
				return nil
			}
		case <-s.ctx.Done():
			return fmt.Errorf("the watch on %s ended: %w", s.key.root, s.ctx.Err())
		}
	}
}

// superseded reports whether the running plan is out of date.
//
// This is the check that keeps editing cheap. A replan is asked for on every
// coalesced batch of file changes, and the overwhelming majority of them change
// a manifest's contents rather than the set of objects it declares — a replica
// count, an image tag, a label. Rebuilding for those would relist every group
// on every save, so the checkout is re-read and compared, and the connections
// are left alone when the answer is the same.
//
// Re-reading is not free: it is a walk of the worktree's YAML. It is
// nevertheless much cheaper than the relist it avoids, it happens on this
// session's own goroutine rather than in front of the editor, and it is the
// only way to know — a file-change event says a path changed, not what it now
// declares.
func (s *session) superseded(planned []Object) bool {
	objects, notices, err := s.manifests.Declared(s.key.root, s.key.target, s.key.namespace)
	if err != nil {
		// A checkout that has become unreadable is a reason to rebuild: the
		// cycle will report the failure rather than keep watching against a
		// plan nothing can confirm.
		return true
	}
	s.setNotices(notices)
	return !slices.Equal(planned, objects)
}

// setPhase records the connection's state and announces it.
func (s *session) setPhase(phase Phase, reason string) {
	s.mu.Lock()
	changed := s.phase != phase || s.reason != reason
	s.phase, s.reason = phase, reason
	s.mu.Unlock()

	if changed {
		s.changed()
	}
}

// setNotices records what the checkout could not be read for.
func (s *session) setNotices(notices []Notice) {
	s.mu.Lock()
	s.notices = notices
	s.mu.Unlock()
	s.changed()
}

// seed replaces the object list with a freshly planned one.
//
// Everything starts NotFound rather than carrying over its previous health.
// Carrying over would mean a rebuild after a rebind showed the old cluster's
// verdicts against the new cluster's name for as long as the first list took —
// which is the one moment in this package's life where a stale reading would be
// actively dangerous.
func (s *session) seed(order []Status) {
	s.mu.Lock()
	s.objects = order
	s.mu.Unlock()
	s.changed()
}

// clear empties the object list, for a session with nothing to watch.
func (s *session) clear() {
	s.mu.Lock()
	s.objects = nil
	s.mu.Unlock()
	s.changed()
}

// mark records one object's health, by its index in the planned order.
func (s *session) mark(index int, health Health, message string) {
	s.mu.Lock()
	changed := false
	if index < len(s.objects) {
		current := &s.objects[index]
		changed = current.Health != health || current.Message != message
		current.Health, current.Message = health, message
	}
	s.mu.Unlock()

	if changed {
		s.changed()
	}
}

// changed asks the announcer to publish. It never blocks: a stalled webview
// must not be in the path of a watch event.
func (s *session) changed() {
	select {
	case s.dirty <- struct{}{}:
	default:
	}
}

// announce publishes state changes, leading-edge and then rate-limited. See
// publishInterval.
func (s *session) announce() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.dirty:
		}

		s.events.PublishHealthChanged(s.key.root)

		if !wait(s.ctx, publishInterval) {
			return
		}
	}
}
