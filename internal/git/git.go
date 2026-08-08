// Package git reports what the system `git` says about a project's working
// tree (DESIGN.md §3.2, §7): which paths differ from the index and from HEAD,
// which are unmerged, and where the current branch sits relative to its
// upstream.
//
// It is mostly a reader: status and blame mutate nothing, so every invocation
// of them is safe to run on a filesystem event, which is how the workbench
// keeps its badges current. ops.go is the other half of DESIGN.md §7 — pull,
// push and branch switch — and it goes through the same runner rather than a
// second one of its own.
//
// That runner is internal/gitexec, which is where the process is actually
// started: it pins the locale the not-a-repository match depends on, keeps a
// read from rewriting .git/index, bounds the call, and carries git's stderr out
// verbatim. This package parses what comes back and knows nothing else about
// how it got there. The split exists so a second git reader can be written
// without duplicating any of that (#53); the parsers here are not it.
//
// When git is missing, or the path is no longer a repository, that is reported
// as a state on Status rather than as an error: both are things a user can see
// and fix, and neither is a failure of the call. Anything else — a corrupt
// index, a permission error — is an error carrying git's own stderr verbatim,
// because the user knows how to read a git error and a translation would only
// lose detail (DESIGN.md §7).
//
// The package knows nothing about projects, the Wails bridge or the stream
// transport. It takes a worktree path and returns a value; internal/app is
// what binds that to a project and pushes the change notification that makes
// the UI ask again.
package git

// State classifies how one path differs, on one side of the index.
//
// The values are the wire form: they cross the Wails bridge into TypeScript
// and are compared there, so renaming one is a frontend change too. The empty
// string means "no difference on this side", which is what lets a caller test
// a side with `!= ""` rather than carrying a fourth "unmodified" constant that
// every switch would have to remember to handle.
type State string

const (
	// StateModified is content that differs. A typechange (a file becoming a
	// symlink, git's `T`) is reported as this: the tree shows one badge per
	// path, and "the content is not what it was" is what the badge means.
	StateModified State = "modified"

	// StateAdded is a path present on this side but not the one before it.
	StateAdded State = "added"

	// StateDeleted is a path gone from this side.
	StateDeleted State = "deleted"

	// StateRenamed is a path git matched to a different name in HEAD. The
	// name it came from is FileStatus.OrigPath.
	StateRenamed State = "renamed"

	// StateCopied is a path git matched to a source it was copied from,
	// also carried in FileStatus.OrigPath. git only detects copies when
	// asked to, so this is rare in practice and is here because the format
	// can produce it, not because m6t requests it.
	StateCopied State = "copied"

	// StateUntracked is a path git is not tracking. It is only ever a
	// worktree-side state: an untracked path has nothing in the index to
	// compare against.
	StateUntracked State = "untracked"
)

// Availability says whether a project has readable git state, and if not, why.
//
// It is a field rather than an error because both failure values are ordinary
// conditions with a clear thing for the UI to say. A user with no git
// installed, or a project whose checkout has stopped being a repository,
// should see a sentence in the status bar — not an error box every time a file
// is saved.
type Availability string

const (
	// Available means git ran and the status below it is real.
	Available Availability = "ok"

	// NoGit means no `git` executable was found on PATH. Every other field
	// of the Status is zero.
	NoGit Availability = "no-git"

	// NotARepository means git ran but the path is not inside a work tree.
	//
	// The registry refuses to add a directory with no .git entry
	// (internal/project, ErrNotRepository), so the reachable case is a
	// project that stopped being a repository after it was registered — a
	// .git removed by hand, a network volume that unmounted — not a
	// mistake at add time.
	NotARepository Availability = "not-a-repository"
)

// Branch is where the working tree's current branch sits.
type Branch struct {
	// Name is the checked-out branch, or "" when Detached is true.
	Name string `json:"name"`

	// Upstream is the tracking branch's name ("origin/main"), or "" when the
	// branch tracks nothing. Ahead and Behind are only meaningful when it is
	// set — git reports no counts without an upstream to count against.
	Upstream string `json:"upstream"`

	// Ahead and Behind are commits on each side of the upstream.
	Ahead  int `json:"ahead"`
	Behind int `json:"behind"`

	// Detached is HEAD pointing at a commit rather than a branch.
	Detached bool `json:"detached"`

	// Unborn is a repository with no commits yet: `git init` with nothing
	// committed. HEAD names a branch that does not exist, so Name is set
	// while there is nothing for it to point at.
	Unborn bool `json:"unborn"`
}

// FileStatus is one path git reports as differing.
//
// Staged and Worktree are the two halves of porcelain v2's XY pair, kept
// apart rather than collapsed into one badge because the changes panel groups
// by exactly this distinction (DESIGN.md §7): a path can be staged and then
// edited again, which is one entry in both groups.
type FileStatus struct {
	// Path is root-relative and slash-separated — the form the file tree and
	// the editor already use, so a status entry addresses the same rows they
	// do without translation.
	Path string `json:"path"`

	// Staged is how the index differs from HEAD, "" when it does not.
	Staged State `json:"staged"`

	// Worktree is how the working tree differs from the index, "" when it
	// does not.
	Worktree State `json:"worktree"`

	// Conflicted marks an unmerged path. Staged and Worktree are both ""
	// for one: an unmerged path has no index-versus-worktree split to
	// report — it has up to three competing versions — and presenting one
	// would claim a resolution the user has not made.
	Conflicted bool `json:"conflicted"`

	// OrigPath is where a renamed or copied path came from, "" otherwise.
	OrigPath string `json:"origPath"`
}

// Status is one working tree's git state, as of one invocation.
type Status struct {
	Availability Availability `json:"availability"`
	Branch       Branch       `json:"branch"`

	// Files is every path git reported, in git's own order. It is never nil,
	// including on the unavailable paths: it crosses the bridge as JSON, and
	// a null there would reach TypeScript as a value with no length.
	Files []FileStatus `json:"files"`
}

// statusFor builds an empty Status carrying one availability. Files is set
// rather than left nil for the reason the field documents: it marshals to
// JSON, and null would reach TypeScript as a value with no length.
func statusFor(availability Availability) Status {
	return Status{Availability: availability, Files: []FileStatus{}}
}
