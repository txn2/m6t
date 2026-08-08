package git

import (
	"errors"
	"fmt"
	"strings"

	"github.com/txn2/m6t/internal/gitexec"
)

// The daily git loop (DESIGN.md §7): pull, push and branch switch. status.go
// is the reading half of the same section; this is the half that writes.
//
// Staging and committing are not here, and their absence is a decision rather
// than an omission (#39). m6t's answer to "record this work" is the agent in
// the embedded terminal, running the user's own git in the user's own
// worktree; a second writer of the index, driven from the UI and invisible to
// that agent, is two tools disagreeing about one repository. What survives is
// what the branch bar still puts a button on, and none of it writes the index:
// pull and push move refs, and a checkout is gated behind a dirty-worktree
// rule the UI computes from the status it already holds.
//
// Every operation here is one invocation of the system git, through
// internal/gitexec — the same runner status.go and blame.go read with, so a
// write is bounded, logged and reported on the same terms a read is. Nothing is
// composed out of several calls behind the user's back, because a half-applied
// sequence is a state neither the user nor the status reader can explain — if
// `git pull` stops in a conflict, m6t stops with it.
//
// Each of them returns the runner's error unwrapped, which is deliberate rather
// than a missed wrapcheck (the linter is configured for it): that error already
// names the argv that failed and carries git's own stderr, and internal/app
// puts the operation's name in front of the whole thing the way GitStatus
// already does. A wrap here would add "pull" to a message beginning "git pull".
//
// Nothing here serializes against a concurrent call. git's own index.lock is
// the real mutual exclusion, and it has to be: the user's terminal is running
// git against the same repository as often as m6t is, and a mutex in this
// process would protect against only one of the two writers while implying it
// protected against both. A lock collision surfaces as git's own message.

// ErrInvalidRef is a branch or remote name git could read as an option or as
// something other than a ref.
//
// It is a rejection, not a git failure: no subprocess runs. It exists because
// the bound surface is a public API (CLAUDE.md) and the frontend is not the
// only thing that can reach it — a ref argument is checked here rather than
// trusted because it came from a list this package produced.
var ErrInvalidRef = errors.New("not a valid branch or remote name")

// rejectedFormat is the shape of an argument rejection: what was given, then
// why. One constant because revive counts repeats of a literal, and because
// every rejection should read alike when a user hits one.
const rejectedFormat = "resolving %s: %w"

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
	return gitexec.WriteRemote(root, "pull")
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
		return gitexec.WriteRemote(root, "push")
	}
	if err := validateRef(remote); err != nil {
		return err
	}
	return gitexec.WriteRemote(root, "push", "--set-upstream", remote, "HEAD")
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
	return gitexec.Write(root, "checkout", branch, "--")
}

// Branches lists local branches, for the switcher's dropdown.
//
// for-each-ref rather than `git branch`: `git branch` formats for a human —
// it marks the current branch with an asterisk and may paginate or color —
// while for-each-ref emits exactly the names. There is no -z form of it, and
// there does not need to be: git refuses to create a ref containing a control
// character, so one name per line is unambiguous.
func Branches(root string) ([]string, error) {
	out, err := gitexec.Read(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	if err != nil {
		return nil, err
	}
	return lines(out), nil
}

// Remotes lists configured remotes, so the push prompt can offer the real ones
// instead of assuming a repository has an "origin".
func Remotes(root string) ([]string, error) {
	out, err := gitexec.Read(root, "remote")
	if err != nil {
		return nil, err
	}
	return lines(out), nil
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
