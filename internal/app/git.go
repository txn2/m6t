package app

import (
	"fmt"

	"github.com/txn2/m6t/internal/git"
)

// GitStatus reports what git says about a project's working tree: the branch
// and its position against its upstream, and every path that differs
// (DESIGN.md §7). root is the project's own path, the same convention
// ListDirectory and OpenTerminal already take.
//
// This is a binding rather than a push over the transport, for the reason
// every other binding on this object exists: it is a request with an answer
// and no throughput. The /events channel carries only the notification that
// the answer may have changed (PROTOCOL.md §5, `git`), which is what keeps a
// status structure — a type internal/git owns — off a wire the stream server
// would then have to know the schema of.
//
// It takes no App state, so the receiver is unnamed: internal/git holds
// nothing between calls. There is no watcher to start and no handle to
// compose, because a status is read from the repository every time it is
// asked for; the watcher that says when to ask is #6's, already running.
func (*App) GitStatus(root string) (git.Status, error) {
	status, err := git.Load(root)
	if err != nil {
		return git.Status{}, fmt.Errorf("reading git status in %s: %w", root, err)
	}
	return status, nil
}
