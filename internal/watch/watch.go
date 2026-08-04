// Package watch owns the file tree behind m6t's workbench (DESIGN.md §3.2,
// §5): lazy, one-directory-at-a-time listing of a project's worktree, the
// create/rename/delete operations the tree UI drives, and the fsnotify-backed
// watcher that keeps it in sync with changes made outside the app — a
// terminal pane running `git checkout`, an editor elsewhere, `rm` at a shell.
//
// Every operation is confined to a project's root by os.Root (Go 1.24+): a
// traversal out of the worktree is refused by the kernel-level check the
// standard library performs, not by a convention this package would
// otherwise have to keep — the same approach internal/project takes for its
// own configuration directory. .git is refused by policy on top of that: a
// file tree is not a place to browse or edit repository internals, and the
// watcher tracks it separately from what List ever shows.
//
// The package knows nothing about projects, the Wails bridge or the stream
// transport. It takes a root path and returns entries and change
// notifications through a seam it declares (Events); internal/app is what
// wires a root to a project and Events to the loopback stream server.
package watch

import (
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// gitDir is the repository metadata directory. List, Create, Rename and
// Delete never reach into it: browsing or editing .git's contents is not
// what a manifest-repo file tree is for. The watcher is the one thing that
// does look inside it (fsnotify.go), because DESIGN.md §3.2 wants HEAD and
// refs changes flowing for #8 to pick up later.
const gitDir = ".git"

// Filesystem permissions for entries this package creates. 0640/0750 rather
// than a more permissive default: a manifest repository can hold anything a
// project keeps in it, and a new file or directory should start as private
// as the registry (internal/project) already treats projects.yaml.
const (
	filePerm = 0o640
	dirPerm  = 0o750
)

// Sentinel errors. Values rather than formatted strings so a caller —
// internal/app's bindings, and their tests — can tell "you asked for
// something outside the worktree" from "the disk said no", which read very
// differently to a user.
var (
	// ErrOutsideRoot reports a path that would resolve outside a project's
	// worktree, textually or through a symlink.
	ErrOutsideRoot = errors.New("path escapes the project root")

	// ErrGitInternal reports a path inside .git, which tree operations
	// refuse to touch.
	ErrGitInternal = errors.New("path is inside .git")

	// ErrNoPath reports an operation that named the root itself where a
	// concrete entry was required — root cannot be created, renamed or
	// deleted through this package.
	ErrNoPath = errors.New("no path given")

	// ErrAlreadyExists reports a Create or Rename whose destination is
	// already occupied. Create and Rename never overwrite.
	ErrAlreadyExists = errors.New("path already exists")
)

// Entry is one immediate child of a listed directory.
type Entry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
}

// Events is the seam watch pushes change notifications through. internal/app
// wires it to the loopback stream server (PROTOCOL.md §5); watch itself
// never imports that package, the same way internal/stream declares its own
// Terminals seam rather than importing internal/pty.
type Events interface {
	// PublishTreeChanged reports that one or more directories under root
	// (relative paths, "" for root itself) may have changed. It is a
	// coalesced batch, not one call per filesystem event — see the
	// coalescer in fsnotify.go for why.
	PublishTreeChanged(root string, dirs []string)
}

// sortEntries orders directories before files, then case-insensitively by
// name — the shape a file tree reads naturally, and stable so a directory
// that hasn't changed doesn't reorder itself between listings.
func sortEntries(entries []Entry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
}

// dirOf returns the parent directory of a root-relative, slash-separated
// path, in the same form. It is what the watcher reports changed: a file's
// own name is not useful to a tree that only ever re-lists directories.
// path.Dir(".") is already "." — root's own parent, for this purpose, is
// itself — so there is no separate case to give it.
func dirOf(name string) string {
	return path.Dir(name)
}

// relFromOS converts a native filesystem path under root to the
// slash-separated, root-relative form this package's public API and wire
// protocol use throughout.
func relFromOS(root, osPath string) (string, error) {
	rel, err := filepath.Rel(root, osPath)
	if err != nil {
		return "", fmt.Errorf("relativizing %s: %w", osPath, err)
	}
	return filepath.ToSlash(rel), nil
}
