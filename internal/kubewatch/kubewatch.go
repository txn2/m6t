// Package kubewatch answers, live, what state the cluster is in for the
// objects a project declares (DESIGN.md §3.2, §5).
//
// # Read-only by construction
//
// Nothing here can change a cluster. The package calls list, watch and nothing
// else — no create, update, patch, apply or delete appears in its source, and
// readonly_test.go fails the build if one ever does. That is the whole safety
// argument for this package existing beside internal/kubeexec rather than
// inside it: the mutation path has a confirmation gate in front of it
// (DESIGN.md §6.1), and a package that both watches and mutates would be a
// package where a future call could reach the cluster without passing that
// gate. Here there is no such call to write.
//
// It reaches the cluster through client-go rather than through kubectl,
// unlike every other Kubernetes path in m6t. A watch is a long-lived streaming
// connection whose failures — an expired credential, a 410 Gone on a stale
// resourceVersion, a proxy that closed the socket — are states this package has
// to distinguish and report, and `kubectl get --watch` collapses all of them
// into a process that exited.
//
// # What it watches, and what it does not
//
// A session watches exactly the objects a project's checkout declares. It never
// browses: there is no "show me everything in the namespace", because the
// question the panel answers is whether what the repository asked for is what
// the cluster has, and an object nobody declared is not part of that question.
//
// The connection is grouped by resource and namespace rather than by object,
// because that is what the API offers. Watching six Deployments in one
// namespace individually would be six connections; one namespaced watch,
// filtered to the six names, is one. The exception is a group holding a single
// object, which is narrowed with a field selector — the common shape of a
// repository with one Deployment, one Service and one Ingress per namespace,
// where the general form would list every Secret in the namespace to learn
// about one.
//
// # Failure is a state, not an exit
//
// Every failure is reported as a Phase and retried. An expired token, a laptop
// that slept, a VPN that dropped: each is a condition that resolves itself the
// moment the user fixes it, and a session that gave up would leave a panel
// showing health it stopped verifying — the silently-frozen panel #12 exists to
// rule out. What is never done is showing the last known state as though it
// were current: the phase sits beside the objects, and it says what is
// actually happening to the connection under them.
//
// It imports nothing first-party (CLAUDE.md, DESIGN.md §3.2). What a project
// declares arrives through the Manifests seam, and where events go through the
// Events seam; internal/app wires both.
package kubewatch

import (
	"context"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/dynamic"
)

// Manifests is the seam through which a session learns what to watch.
//
// It is re-asked on every plan rather than handed in once, because a checkout
// is edited while it is being watched: the answer has to be current at the
// moment the watch is built, not at the moment the project was opened.
type Manifests interface {
	// Declared reports the objects a checkout at root declares that belong to
	// the given context and namespace, and whatever could not be read.
	//
	// The binding is an argument rather than something this package filters on
	// afterwards, because deciding which objects belong to it is the project
	// registry's job: a manifest under a folder carrying an override belongs to
	// that folder's cluster, and only the registry knows the override exists.
	//
	// An error means the checkout itself could not be scanned, which is
	// different from a checkout that declares nothing.
	Declared(root, target, namespace string) ([]Object, []Notice, error)
}

// Events is the seam a session announces through. It carries no state, for the
// reason internal/stream's gitPayload gives: the consumer asks for the current
// snapshot, so an event that carried one would be a second answer that could
// disagree with the first.
type Events interface {
	PublishHealthChanged(root string)
}

// Connector builds cluster access for a kubeconfig context.
//
// It returns client-go's own types rather than an interface of this package's
// invention, so a test supplies `dynamic/fake` and a static RESTMapper and
// exercises the real code path. Connect is the production implementation.
type Connector func(contextName string) (dynamic.Interface, meta.RESTMapper, error)

// publishInterval is the floor between two announcements for one project.
//
// A rolling Deployment produces watch events at the rate the API server
// observes pods, and every one of them is a reason for the panel to redraw. The
// announcement is edge-triggered and then rate-limited: the first change is
// published immediately, and everything within the interval after it collapses
// into one further announcement. That keeps a rollout at five frames a second
// instead of fifty, and — because the event carries no state — costs nothing
// but latency the user cannot perceive.
const publishInterval = 200 * time.Millisecond

// Service owns the live watch sessions, one per project root.
//
// One instance covers the application, the shape internal/watch and
// internal/pty already take: sessions are backend-owned and their lifetime
// follows the project, not any window or tab.
//
// A Service is safe for concurrent use.
type Service struct {
	manifests Manifests
	connect   Connector
	events    Events

	mu       sync.Mutex
	sessions map[sessionKey]*session
}

// sessionKey identifies a session: a checkout and the binding it is watched
// against.
//
// The binding is part of the identity rather than something a session is
// retargeted with, because one project legitimately has more than one. A
// repository laid out one directory per cluster is the case folder overrides
// exist for (DESIGN.md §4), and its `dev/` and `prod/` trees are two sets of
// objects in two clusters — one session each, watched at once, is the only
// arrangement that can report both truthfully.
//
// It also means a session never has to unwind a retarget. A binding that moves
// is a different key, so the old session's verdicts cannot leak into the new
// one's rows: the stale reading this package must never produce is impossible
// rather than guarded against.
type sessionKey struct {
	root      string
	target    string
	namespace string
}

// New builds a Service. connect is the seam onto the cluster; production passes
// Connect.
func New(manifests Manifests, connect Connector, events Events) *Service {
	return &Service{
		manifests: manifests,
		connect:   connect,
		events:    events,
		sessions:  make(map[sessionKey]*session),
	}
}

// Watch puts a checkout under watch against a binding and returns what is
// currently known about it.
//
// It is idempotent: the second call for a binding already being watched is a
// read. Returning the snapshot rather than only starting is what lets the
// frontend use one call for both "show me this" and "something changed, ask
// again" — a first call answers PhaseConnecting with nothing observed yet, and
// the announcement that follows is what tells the caller to ask a second time.
//
// An incomplete binding starts nothing. A project sits unbound until the user
// binds it, and connecting to "whatever the kubeconfig would have picked" is
// the accident DESIGN.md §4 exists to prevent — read-only or not.
func (s *Service) Watch(root, target, namespace string) Snapshot {
	if target == "" || namespace == "" {
		return idle(unboundReason)
	}

	key := sessionKey{root: root, target: target, namespace: namespace}

	s.mu.Lock()
	live, ok := s.sessions[key]
	if !ok {
		live = newSession(key, s.manifests, s.connect, s.events)
		s.sessions[key] = live
	}
	s.mu.Unlock()

	return live.snapshot()
}

// unboundReason is what an unbound selection reads as.
const unboundReason = "no kube context and namespace are bound"

// idle is a snapshot for a binding no session exists for.
//
// The slices are empty rather than nil, and that is not cosmetic: this value
// crosses the Wails bridge, where a nil slice marshals to `null` rather than to
// `[]`, and the panel that receives it iterates them. An unbound project is the
// state every project starts in, so a nil here would be a crash on the most
// common thing this call can answer. session.snapshot allocates for the same
// reason.
func idle(reason string) Snapshot {
	return Snapshot{
		Phase:   PhaseIdle,
		Reason:  reason,
		Objects: []Status{},
		Notices: []Notice{},
	}
}

// Refresh tells every session on a checkout that it may declare something
// different now. It is a no-op for a checkout nobody watches, which is what
// lets the file-change path call it for every project without first asking
// which ones have panels open.
//
// A session re-reads the checkout and rebuilds only if the set of objects it is
// responsible for actually changed. A save that edits a Deployment's replica
// count changes nothing about what is watched, and a relist on every
// keystroke-save would be this package's contribution to making the editor
// slow.
func (s *Service) Refresh(root string) {
	for _, live := range s.matching(root) {
		live.replan()
	}
}

// Stop ends every session on a checkout. Stopping one that is not running is a
// no-op.
func (s *Service) Stop(root string) {
	s.mu.Lock()
	var live []*session
	for key, sess := range s.sessions {
		if key.root == root {
			live = append(live, sess)
			delete(s.sessions, key)
		}
	}
	s.mu.Unlock()

	for _, sess := range live {
		sess.stop()
	}
}

// matching returns the live sessions on a checkout.
func (s *Service) matching(root string) []*session {
	s.mu.Lock()
	defer s.mu.Unlock()

	var live []*session
	for key, sess := range s.sessions {
		if key.root == root {
			live = append(live, sess)
		}
	}
	return live
}

// Shutdown ends every session and waits for them, which is what the application
// calls on the way out. Waiting rather than signaling: a watch goroutine
// outliving the process's decision to exit is a connection the API server keeps
// open until it times out.
func (s *Service) Shutdown() {
	s.mu.Lock()
	live := make([]*session, 0, len(s.sessions))
	for root, sess := range s.sessions {
		live = append(live, sess)
		delete(s.sessions, root)
	}
	s.mu.Unlock()

	for _, sess := range live {
		sess.stop()
	}
}

// wait blocks for d, or until ctx is done, and reports whether the full delay
// elapsed. It is the one place this package sleeps.
func wait(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
