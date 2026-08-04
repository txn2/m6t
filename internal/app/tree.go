package app

import (
	"fmt"

	"github.com/txn2/m6t/internal/project"
	"github.com/txn2/m6t/internal/stream"
	"github.com/txn2/m6t/internal/watch"
)

// treeBridge presents the loopback stream server through the seam
// internal/watch declares (watch.Events). The two are sibling backend
// services and must not import each other, so the binding layer does the
// one-line adaptation — the same shape terminalBridge already takes for the
// PTY service in terminals.go.
type treeBridge struct {
	streams *stream.Server
}

// PublishTreeChanged forwards a coalesced batch of changed directories onto
// the /events channel (PROTOCOL.md §5).
func (b treeBridge) PublishTreeChanged(root string, dirs []string) {
	b.streams.PublishTree(root, dirs)
}

// startRegisteredWatchers begins watching every project already in the
// registry when the app starts — every registered project is an open tab
// from the moment the window appears, so DESIGN.md §3.2's "each open
// project's worktree" means all of them, not just the selected one.
//
// A free function over the two handles it needs rather than an App method:
// it is wiring between services the binding layer already holds, and
// TestAppGodObjectBudget's method count is reserved for coordinator
// behavior, not this.
func startRegisteredWatchers(projects *project.Registry, trees *watch.Service) {
	all, err := projects.List()
	if err != nil {
		// A registry that cannot be read reports itself through Projects()
		// when the frontend asks; there is nothing to watch and nothing
		// further to do here.
		return
	}
	for _, p := range all {
		_ = trees.Start(p.Path)
	}
}

// ListDirectory returns the immediate children of relPath under a project's
// worktree — "" or "." lists the worktree's root (DESIGN.md §5). root is
// the project's own path, the same convention OpenTerminal's cwd already
// uses: this binding does not need a project's name to serve it, and takes
// no App state — the receiver is unnamed for exactly that reason.
func (*App) ListDirectory(root, relPath string) ([]watch.Entry, error) {
	entries, err := watch.List(root, relPath)
	if err != nil {
		return nil, fmt.Errorf("listing %s in %s: %w", relPath, root, err)
	}
	return entries, nil
}

// CreateEntry makes a new empty file or directory in a project's worktree.
func (*App) CreateEntry(root, relPath string, isDir bool) error {
	if err := watch.Create(root, relPath, isDir); err != nil {
		return fmt.Errorf("creating %s in %s: %w", relPath, root, err)
	}
	return nil
}

// RenameEntry moves an entry within a project's worktree. It never
// overwrites an existing destination.
func (*App) RenameEntry(root, fromRelPath, toRelPath string) error {
	if err := watch.Rename(root, fromRelPath, toRelPath); err != nil {
		return fmt.Errorf("renaming %s to %s in %s: %w", fromRelPath, toRelPath, root, err)
	}
	return nil
}

// DeleteEntry removes an entry from a project's worktree — a file outright,
// a directory and everything in it. The tree UI confirms with the user
// before calling this (the issue's "confirm on delete" criterion); by the
// time it is called, the decision has already been made.
func (*App) DeleteEntry(root, relPath string) error {
	if err := watch.Delete(root, relPath); err != nil {
		return fmt.Errorf("deleting %s in %s: %w", relPath, root, err)
	}
	return nil
}
