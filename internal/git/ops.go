package git

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"strings"
)

// The daily git loop (DESIGN.md §7): stage, unstage, commit, pull, push and
// branch switch. status.go is the reading half of the same section; this is
// the half that writes.
//
// Every operation here is one invocation of the system git with an argv slice.
// Nothing is composed out of several calls behind the user's back, because a
// half-applied sequence is a state neither the user nor the status reader can
// explain — if `git pull` stops in a conflict, m6t stops with it.
//
// Nothing here serializes against a concurrent call. git's own index.lock is
// the real mutual exclusion, and it has to be: the user's terminal is running
// git against the same repository as often as m6t is, and a mutex in this
// process would protect against only one of the two writers while implying it
// protected against both. A lock collision surfaces as git's own message.

// Argument failures. These are rejections, not git failures: no subprocess
// runs. They exist because the bound surface is a public API (CLAUDE.md) and
// the frontend is not the only thing that can reach it — a path argument is
// checked here rather than trusted because it came from a status this package
// produced.
var (
	// ErrNoPaths is an operation given nothing to act on.
	ErrNoPaths = errors.New("no paths given")

	// ErrOutsideRoot is a path that does not name something inside the
	// worktree: absolute, containing "..", or naming .git itself.
	ErrOutsideRoot = errors.New("path is outside the repository")

	// ErrEmptyMessage is a commit whose message has no content. git refuses
	// this too; catching it here keeps the UI's disabled-button rule and the
	// backend's rule from being able to disagree.
	ErrEmptyMessage = errors.New("commit message is empty")

	// ErrInvalidRef is a branch or remote name git could read as an option or
	// as something other than a ref.
	ErrInvalidRef = errors.New("not a valid branch or remote name")
)

// gitDir is the one directory inside a worktree no operation may name.
const gitDir = ".git"

// rejectedFormat is the shape of every argument rejection above: what was
// given, then why. One constant because revive counts repeats of a literal,
// and because the four rejections should read alike when a user hits one.
const rejectedFormat = "resolving %s: %w"

// Stage adds paths to the index — the "stage" half of the changes panel.
//
// A deleted path stages its deletion and a conflicted path is marked
// resolved, both of which are `git add`'s own behavior and both of which are
// what the button means where it appears.
func Stage(root string, paths []string) error {
	specs, err := pathspecs(paths)
	if err != nil {
		return err
	}
	return mutate(root, invocation{}, append([]string{"add", "--"}, specs...)...)
}

// Unstage removes paths from the index, leaving the working tree alone.
//
// `git reset` rather than `git restore --staged`: restore resolves HEAD, so on
// a repository with no commits yet it fails outright, and the first thing a
// user does in a fresh repository is stage the wrong file.
func Unstage(root string, paths []string) error {
	specs, err := pathspecs(paths)
	if err != nil {
		return err
	}
	// -q because reset prints the unstaged paths to stdout on success and
	// nothing reads them.
	return mutate(root, invocation{}, append([]string{"reset", "-q", "--"}, specs...)...)
}

// Commit records the index under message.
//
// The message goes in on stdin rather than as `-m`: it is multi-line prose of
// no bounded length, and stdin is the one channel that cannot run into an argv
// limit or end up in the log line runWith writes.
//
// Nothing is passed about signing. Whether a commit is signed is
// `commit.gpgsign` in the user's own config, and this is the user's own git —
// a flag here would override a repository policy m6t has no business having an
// opinion about.
func Commit(root, message string) error {
	if strings.TrimSpace(message) == "" {
		return ErrEmptyMessage
	}
	// --cleanup=whitespace is what `default` already does for a message given
	// on stdin; saying it outright means a future change to git's default
	// cannot silently start stripping lines that begin with "#" out of a
	// message the user typed.
	return mutate(root, invocation{stdin: message}, "commit", "--cleanup=whitespace", "-F", "-")
}

// Pull integrates the upstream branch, honoring the repository's own
// pull.rebase and branch.<name>.rebase configuration (DESIGN.md §7). No
// --rebase or --no-rebase is passed: the repository already answers that
// question, and overriding it here would rewrite history in repositories whose
// owners configured merges.
//
// A pull that ends in a conflict is a failed call carrying git's explanation.
// The conflicted paths themselves are not reported here — they arrive through
// Load, which is the one place the working tree's state is read, so the UI
// never has two sources for the same fact.
func Pull(root string) error {
	return mutate(root, invocation{network: true}, "pull")
}

// Push publishes the current branch.
//
// With setUpstream, remote must name where to publish and the branch is
// pushed as HEAD, which makes git set the tracking branch to that remote's
// branch of the same name — the case a branch created locally and never
// pushed lands in. Without it, remote is ignored and git's own push
// configuration decides, because a branch that already has an upstream has
// already answered the question.
func Push(root, remote string, setUpstream bool) error {
	if !setUpstream {
		return mutate(root, invocation{network: true}, "push")
	}
	if err := validateRef(remote); err != nil {
		return err
	}
	return mutate(root, invocation{network: true}, "push", "--set-upstream", remote, "HEAD")
}

// Checkout switches to an existing local branch.
//
// The trailing `--` is not decoration: without it `git checkout main` in a
// worktree that also contains a file called `main` is ambiguous, and git
// resolves the ambiguity by checking out the *file*, silently discarding the
// user's edits to it. The separator says the argument before it is a revision.
//
// Branch creation is out of scope for v1 (DESIGN.md §10), so a name that names
// no branch is git's error to report rather than an invitation to create one.
func Checkout(root, branch string) error {
	if err := validateRef(branch); err != nil {
		return err
	}
	return mutate(root, invocation{}, "checkout", branch, "--")
}

// Branches lists local branches, for the switcher's dropdown.
//
// for-each-ref rather than `git branch`: `git branch` formats for a human —
// it marks the current branch with an asterisk and may paginate or color —
// while for-each-ref emits exactly the names. There is no -z form of it, and
// there does not need to be: git refuses to create a ref containing a control
// character, so one name per line is unambiguous.
func Branches(root string) ([]string, error) {
	out, err := runGit(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	if err != nil {
		return nil, err
	}
	return lines(out), nil
}

// Remotes lists configured remotes, so the push prompt can offer the real ones
// instead of assuming a repository has an "origin".
func Remotes(root string) ([]string, error) {
	out, err := runGit(root, "remote")
	if err != nil {
		return nil, err
	}
	return lines(out), nil
}

// mutate runs one writing invocation and discards its stdout.
//
// The error comes back exactly as classify built it — naming the argv that
// failed and carrying git's own stderr — with nothing added. There is no
// context left for this layer to supply: the argv already contains the
// repository, and internal/app puts the operation's name in front of the whole
// thing the way GitStatus already does.
func mutate(root string, call invocation, args ...string) error {
	_, err := runWith(root, call, args...)
	return err
}

// lines splits command output into non-empty trimmed lines.
func lines(out string) []string {
	// Never nil: these cross the Wails bridge as JSON, and a null there would
	// reach TypeScript as a value with no length.
	found := []string{}
	for line := range strings.SplitSeq(out, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			found = append(found, trimmed)
		}
	}
	return found
}

// pathspecs turns caller paths into pathspecs git will treat as literal file
// names.
//
// The `:(literal)` prefix is the load-bearing part. A bare path is a *glob*:
// git reads `weird[1].yaml` as a character class and stages nothing, and a
// path beginning with `-` is read as an option even after `--`, because `--`
// separates revisions from pathspecs and does not stop magic from being
// parsed. `:(literal)` says the rest of the string is the name, exactly.
func pathspecs(paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, ErrNoPaths
	}
	specs := make([]string, 0, len(paths))
	for _, p := range paths {
		clean, err := relative(p)
		if err != nil {
			return nil, err
		}
		specs = append(specs, ":(literal)"+clean)
	}
	return specs, nil
}

// relative validates one caller path and returns its slash-separated form.
//
// fs.ValidPath is the authoritative syntactic check — the same one
// internal/watch validates against — and it refuses absolute paths, ".." and
// the other shapes fs.FS forbids on every platform. "." is refused on top of
// it: it names the whole worktree, and an operation that quietly staged
// everything when given an empty-looking argument is the kind of thing a user
// discovers after committing it.
func relative(relPath string) (string, error) {
	clean := path.Clean(filepath.ToSlash(relPath))
	if !fs.ValidPath(clean) || clean == "." {
		return "", fmt.Errorf(rejectedFormat, relPath, ErrOutsideRoot)
	}
	if clean == gitDir || strings.HasPrefix(clean, gitDir+"/") {
		return "", fmt.Errorf(rejectedFormat, relPath, ErrOutsideRoot)
	}
	return clean, nil
}

// validateRef rejects a branch or remote name git could read as something
// other than a name.
//
// A leading "-" is the one that matters: `git checkout --hard` reaches
// checkout as a flag, not as a branch that does not exist. Whitespace and
// control characters are refused as well — git will not create a ref
// containing them, so a name carrying one did not come from Branches and has
// nothing to switch to.
func validateRef(name string) error {
	if name == "" || strings.HasPrefix(name, "-") {
		return fmt.Errorf(rejectedFormat, name, ErrInvalidRef)
	}
	if strings.ContainsFunc(name, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
		return fmt.Errorf(rejectedFormat, name, ErrInvalidRef)
	}
	return nil
}
