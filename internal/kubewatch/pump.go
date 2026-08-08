package kubewatch

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/watch"
	"sigs.k8s.io/cli-utils/pkg/kstatus/status"
)

// pump keeps one group current: list once, then follow.
//
// The list is what makes an absent object absent. A watch started without one
// reports changes and never reports the state before them, so a Deployment that
// has been Current for a week would sit NotFound until something touched it.
//
// It returns only when the connection fails or the context ends. A group the
// user is not allowed to read is not a connection failure — see park.
func (s *session) pump(ctx context.Context, g group) error {
	listed, err := g.client.List(ctx, g.options())
	if err != nil {
		if refused(err) {
			return s.parkGroup(ctx, g, err)
		}
		return fmt.Errorf("listing %s: %w", g.describe(), err)
	}
	s.applyList(g, listed)

	version := listed.GetResourceVersion()
	for {
		var delivered bool
		version, delivered, err = s.followFrom(ctx, g, version)
		if err != nil {
			return err
		}
		// A watch that closed cleanly is re-opened, which is the normal course:
		// the API server ages connections out every few minutes. One that closed
		// cleanly having delivered NOTHING is a different animal — a proxy that
		// hangs up on every watch, or a server that does not support the verb —
		// and re-opening it immediately is a loop that hammers the cluster as
		// fast as the network allows. The pause costs nothing in the normal case,
		// where the watch lived for minutes.
		if !delivered && !wait(ctx, minBackoff) {
			return failed(g, ctx.Err())
		}
	}
}

// failed names the group a failure came from.
//
// Every error this file returns is rendered through it, so the sentence the
// panel shows for a broken watch cannot drift between the four places that
// produce one — and so a reader can tell a Deployment watch's failure from a
// Secret watch's, which the transport's own message never says.
func failed(g group, cause error) error {
	return fmt.Errorf("watching %s: %w", g.describe(), cause)
}

// refused reports whether an error means "you may not read this" rather than
// "the connection is broken".
//
// Forbidden is the ordinary shape of a developer with namespace-scoped access
// in a shared cluster, and NotFound on a list is a namespace that does not
// exist yet — which is exactly the state a repository sits in before its first
// apply. Neither is a reason to tear down a session that is watching four other
// groups perfectly well.
func refused(err error) bool {
	return apierrors.IsForbidden(err) || apierrors.IsNotFound(err)
}

// parkGroup marks a group's objects unreadable and waits out the session.
//
// It blocks rather than returning, because returning would end the cycle for
// every other group; and it blocks rather than retrying, because RBAC does not
// change on a fifteen-second timer. The objects say Unknown with the API
// server's own message, which is the honest answer: m6t does not know their
// health and has been told why.
func (s *session) parkGroup(ctx context.Context, g group, cause error) error {
	for _, indices := range g.names {
		for _, index := range indices {
			s.mark(index, HealthUnknown, apiMessage(cause))
		}
	}
	<-ctx.Done()
	return failed(g, ctx.Err())
}

// followFrom opens a watch at version and consumes it until it ends, returning
// the version to resume from and whether the watch delivered anything.
//
// A watch channel closing is normal: the API server ages connections out, and
// the answer is to open another from where this one stopped. A watch.Error
// event is not normal — a 410 Gone on a resourceVersion the server has
// compacted past is the common one — and it is returned as an error so the
// cycle rebuilds, which relists and makes the panel correct rather than merely
// connected.
func (s *session) followFrom(ctx context.Context, g group, version string) (resume string, delivered bool, err error) {
	options := g.options()
	options.ResourceVersion = version
	options.AllowWatchBookmarks = true

	watcher, err := g.client.Watch(ctx, options)
	if err != nil {
		return "", false, failed(g, err)
	}
	defer watcher.Stop()

	// The context is selected on rather than relied upon to close the channel.
	// A canceled request does close a real client-go watch, but this loop is
	// what Shutdown waits behind, and a shutdown that depends on a third party
	// noticing a cancellation is a shutdown that hangs the first time one does
	// not.
	for {
		select {
		case <-ctx.Done():
			return "", delivered, failed(g, ctx.Err())
		case event, open := <-watcher.ResultChan():
			if !open {
				return version, delivered, nil
			}
			if event.Type == watch.Error {
				return "", delivered, failed(g, fromEvent(event))
			}
			delivered = true
			version = s.consume(g, event, version)
		}
	}
}

// consume records one watch event and returns the version to resume from.
//
// An event carrying something that is not an object — which a conforming server
// does not send outside the error case the caller already handled — is dropped
// rather than guessed at, and leaves the resume point where it was.
func (s *session) consume(g group, event watch.Event, version string) string {
	object, ok := event.Object.(*unstructured.Unstructured)
	if !ok {
		return version
	}
	if resumed := object.GetResourceVersion(); resumed != "" {
		version = resumed
	}
	s.applyEvent(g, event.Type, object)
	return version
}

// fromEvent turns a watch.Error event's payload into an error.
//
// The payload is normally a metav1.Status, which apierrors can turn back into
// the typed error the rest of this package tests with — that is how a 410 Gone
// stays distinguishable from a 401 after crossing the watch channel.
func fromEvent(event watch.Event) error {
	if s, ok := event.Object.(*metav1.Status); ok {
		return &apierrors.StatusError{ErrStatus: *s}
	}
	return errors.New("the watch ended with an error the server did not describe")
}

// applyList records what one group's initial list found.
//
// Objects the group is responsible for and the list did not return keep the
// NotFound the plan seeded them with, which is what makes "declared but absent"
// a state the panel shows rather than a row that never updates.
func (s *session) applyList(g group, listed *unstructured.UnstructuredList) {
	seen := make(map[string]bool, len(listed.Items))
	for i := range listed.Items {
		object := &listed.Items[i]
		seen[object.GetName()] = true
		s.record(g, object)
	}

	for name, indices := range g.names {
		if seen[name] {
			continue
		}
		for _, index := range indices {
			s.mark(index, HealthNotFound, "")
		}
	}
}

// applyEvent records one watch event.
//
// A bookmark carries a resourceVersion and no object state, and is handled by
// the caller advancing the version — there is nothing to record here.
func (s *session) applyEvent(g group, kind watch.EventType, object *unstructured.Unstructured) {
	switch kind {
	case watch.Added, watch.Modified:
		s.record(g, object)
	case watch.Deleted:
		for _, index := range g.names[object.GetName()] {
			s.mark(index, HealthNotFound, "")
		}
	case watch.Bookmark, watch.Error:
	}
}

// record computes and stores one live object's health.
func (s *session) record(g group, object *unstructured.Unstructured) {
	indices, declared := g.names[object.GetName()]
	if !declared {
		// A group lists a whole namespace when it covers more than one object,
		// so most of what arrives is someone else's. Ignoring it here rather
		// than filtering at the API is what keeps this to one connection per
		// resource and namespace.
		return
	}

	health, message := compute(object)
	for _, index := range indices {
		s.mark(index, health, message)
	}
}

// compute is the kstatus verdict for one object (DESIGN.md §3.2).
//
// A kind kstatus has no specific rules for falls through to its generic
// condition reading, which is the right default: a CRD that follows the
// standard conditions convention gets a real answer, and one that does not
// reports Current once it exists, which is all anyone can say about it.
//
// A failure to compute is Unknown rather than Failed. The two would look
// similar in the panel and mean opposite things — "the object reports a
// problem" and "m6t could not read the object" — and the second must never be
// shown as the first.
func compute(object *unstructured.Unstructured) (health Health, message string) {
	result, err := status.Compute(object)
	if err != nil {
		return HealthUnknown, err.Error()
	}
	return Health(result.Status.String()), result.Message
}

// apiMessage renders an API error as the sentence a row carries.
//
// The API server's own message is used rather than a rewrite of it: "secrets is
// forbidden: User "dev" cannot list resource "secrets" in API group "" in the
// namespace "prod"" tells the user which permission to ask for, and every
// shorter version of that sentence loses the part they need.
func apiMessage(err error) string {
	if s, ok := errors.AsType[*apierrors.StatusError](err); ok {
		if message := s.Status().Message; message != "" {
			return message
		}
	}
	return err.Error()
}
