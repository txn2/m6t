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

// The mutating half of DESIGN.md §7. Each of these is one operation the
// branch bar puts a control on, and each is a thin pass through to
// internal/git — the binding layer composes services, it does not implement
// them.
//
// Staging and committing are deliberately absent (#39). The bound surface is
// the API (CLAUDE.md) and it is only what the UI calls; the UI has no control
// that writes the index, because m6t's answer to "record this work" is the
// agent in the terminal, running the user's own git in the user's own
// worktree. A binding kept for a caller that does not exist would be a second
// writer of the index, reachable from the bridge, that the agent cannot see.
// What is left is what the branch bar still puts a button on.
//
// None of them returns a status. The mutation changes .git, the watcher
// publishes a `git` event for it (PROTOCOL.md §5), and the frontend reads the
// new status through GitStatus. Returning one here would give the UI two
// sources for the same fact that could disagree — the operation's answer and
// the watcher's — and no rule for which to believe.
//
// Each names what the user asked for and the project it was asked in, then
// hands over what internal/git returned — the argv that failed and git's own
// stderr, unedited (DESIGN.md §7). It is the shape GitStatus above already
// takes, and the reason the message starts with an English verb rather than
// with git's: the first line a user reads should say which button they
// pressed, and git's explanation should be the rest of it.

// GitPull integrates the upstream branch, honoring the repository's own
// rebase configuration.
func (*App) GitPull(root string) error {
	if err := git.Pull(root); err != nil {
		return fmt.Errorf("pulling in %s: %w", root, err)
	}
	return nil
}

// GitPush publishes the current branch. remote is used only when setUpstream
// is true; otherwise the repository's push configuration decides.
func (*App) GitPush(root, remote string, setUpstream bool) error {
	if err := git.Push(root, remote, setUpstream); err != nil {
		return fmt.Errorf("pushing in %s: %w", root, err)
	}
	return nil
}

// GitCheckout switches to an existing local branch.
func (*App) GitCheckout(root, branch string) error {
	if err := git.Checkout(root, branch); err != nil {
		return fmt.Errorf("switching to %s in %s: %w", branch, root, err)
	}
	return nil
}

// GitBranches lists local branches, for the switcher's dropdown.
func (*App) GitBranches(root string) ([]string, error) {
	branches, err := git.Branches(root)
	if err != nil {
		return nil, fmt.Errorf("listing branches in %s: %w", root, err)
	}
	return branches, nil
}

// GitRemotes lists configured remotes, so the push prompt offers the ones this
// repository actually has rather than assuming an "origin".
func (*App) GitRemotes(root string) ([]string, error) {
	remotes, err := git.Remotes(root)
	if err != nil {
		return nil, fmt.Errorf("listing remotes in %s: %w", root, err)
	}
	return remotes, nil
}
