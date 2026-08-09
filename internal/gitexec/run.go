// Package gitexec starts the system `git` and returns what it printed
// (DESIGN.md §3.2, §7).
//
// It is the only place in m6t that creates a git process, and that is a
// structural decision rather than a convenience. Every property the readers
// above it depend on is established here and nowhere else: LC_ALL is pinned so
// git's own messages are the ones ErrNotARepository is matched against, a read
// passes --no-optional-locks so that reading the index does not rewrite it and
// publish the change event that would trigger another read, a local call is
// bounded against a hung network mount and a remote one against a socket that
// stopped answering, and git's stderr comes back verbatim because DESIGN.md §7
// is explicit that a git failure reaches the user as git wrote it.
//
// A second git reader that duplicated those would be a second answer to a
// question this repository has already answered once, and one that got a single
// answer wrong would fail in a way nothing tests for — a reader feeding the
// watcher that triggered it, or a not-a-repository check that silently stops
// matching under a translated locale.
//
// It imports nothing first-party: a dependency root beside internal/buildinfo,
// pinned by depguard rather than by this comment (.golangci.yml). Backend
// services are siblings and must not import each other (DESIGN.md §3.2), so the
// only shape in which more than one of them drives git through one runner is
// the runner sitting below all of them.
//
// git is invoked with an argv slice and never through a shell (CLAUDE.md,
// .semgrep/go-security.yml), so a worktree path holding shell metacharacters is
// inert. The argv is logged on every call: what the app ran against the user's
// repository is the first thing anyone debugging it needs.
//
// A git that runs and fails is an error here, carrying git's own words. The two
// exceptions are ErrNoGit and ErrNotARepository, which are returned as
// sentinels because outside this package they are not failures at all — see
// internal/git's Availability for what they become.
package gitexec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// binaryName is the executable this package drives. It is resolved through
// PATH on every call rather than cached at construction: a user who installs
// git while m6t is running should not have to restart it to get badges, and a
// PATH lookup is a directory scan, not a cost worth caching against a
// subprocess.
const binaryName = "git"

// commandTimeout bounds one local invocation.
//
// A read-only status on a cold, very large repository can take seconds, so
// this is generous. What it is actually for is the case with no other exit:
// git blocked on an unreachable network mount, or waiting on a lock a crashed
// process left behind. Without a deadline that call never returns and the
// project's badges never update again.
const commandTimeout = 30 * time.Second

// networkTimeout bounds an invocation that talks to a remote.
//
// A fetch of a large repository over a slow link is minutes of legitimate
// work, so commandTimeout would abort real transfers. The deadline still
// exists because the failure it guards against is different from the local
// one: a remote that accepted the connection and then stopped answering
// leaves git waiting on a socket with no timeout of its own.
const networkTimeout = 10 * time.Minute

// fatalExit is git's exit status for a fatal error, which includes being run
// outside a repository.
const fatalExit = 128

// notARepositoryMessage is the fragment of git's fatal message that
// distinguishes "this is not a repository" from every other fatal error.
//
// Matching on message text is only sound because commandEnv forces LC_ALL=C:
// with a translated locale this string would be whatever the user's language
// calls it, and the check would silently stop matching.
const notARepositoryMessage = "not a git repository"

// The two conditions a caller turns into a state rather than reporting as a
// failure. They are sentinels, matched with errors.Is, because the caller's
// answer to each is a sentence in the status bar rather than an error box.
var (
	// ErrNoGit reports that no `git` executable was found on PATH.
	ErrNoGit = errors.New("git was not found on PATH")

	// ErrNotARepository reports that git ran but the path is not inside a
	// work tree.
	ErrNotARepository = errors.New("not a git repository")
)

// Read runs a git command that only reads the repository and returns its
// standard output.
//
// It is the shape every git reader wants — status, blame, for-each-ref — and
// it is the one that carries --no-optional-locks. A call that changes anything
// must not come through here: see Write.
func Read(root string, args ...string) (string, error) {
	return run(root, invocation{readOnly: true}, args...)
}

// Write runs a git command that changes the repository, locally.
//
// Its standard output is discarded rather than returned: the operations that
// take this path are performed for their effect, and what they printed on
// success is progress chatter. What a failure printed is not discarded — it
// comes back inside the error, from whichever stream git chose (see
// explanation).
func Write(root string, args ...string) error {
	_, err := run(root, invocation{}, args...)
	return err
}

// WriteRemote is Write for a command that contacts a remote, under
// networkTimeout instead of commandTimeout.
//
// It is a separate function rather than a flag so that the deadline is chosen
// by naming the operation, not by remembering to pass something. A push given
// the local deadline aborts real transfers, and a local command given the
// network deadline hangs the badges for ten minutes.
func WriteRemote(root string, args ...string) error {
	_, err := run(root, invocation{network: true}, args...)
	return err
}

// invocation is how one git call differs from the default one.
//
// The zero value is a mutating, local call — the shape Write wants — so only
// the exceptions have to say anything.
type invocation struct {
	// readOnly adds --no-optional-locks, which stops git from refreshing the
	// index as a side effect of reading it. It is what keeps a status reader
	// from feeding itself: the watcher that triggers a status also watches
	// .git, so a read that wrote .git/index would publish a change, which
	// would trigger another read, forever.
	//
	// A mutating call must NOT set it. Those change .git on purpose, and the
	// resulting event is the notification the UI needs to refresh.
	readOnly bool

	// network extends the deadline to networkTimeout for a call that talks to
	// a remote.
	network bool
}

// run invokes git inside root and returns its standard output.
//
// The argv is a slice and the binary is executed directly — never a shell —
// so a worktree path containing shell metacharacters is inert
// (.semgrep/go-security.yml enforces the no-shell half of this). The argv is
// logged, as CLAUDE.md requires of every external binary.
func run(root string, call invocation, args ...string) (string, error) {
	binary, err := exec.LookPath(binaryName)
	if err != nil {
		return "", ErrNoGit
	}

	argv := call.argv(root, args)
	log.Printf("m6t: running %s %s", binary, strings.Join(argv, " "))

	ctx, cancel := context.WithTimeout(context.Background(), call.deadline())
	defer cancel()

	cmd := exec.CommandContext(ctx, binary, argv...)
	cmd.Env = commandEnv()
	// An empty reader, never the inherited stdin: a git that reached the
	// user's terminal would be reading keystrokes meant for a shell in
	// another pane. Nothing here has input to give it — no operation writes
	// the index (#39) — and an empty stdin is what makes a remote asking for
	// a password fail instead of hang.
	cmd.Stdin = strings.NewReader("")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", call.classify(ctx, err, argv, explanation(stdout.String(), stderr.String()))
	}
	return stdout.String(), nil
}

// explanation picks the stream a failed git wrote its reason to.
//
// Usually that is stderr, and stdout holds output nobody wants in an error
// message. But not always: `git commit` with an empty index exits 1 and writes
// "nothing to commit, working tree clean" to *stdout*, leaving stderr blank.
// Reporting only stderr there gives the user "exit status 1" and nothing else,
// which is exactly the loss of detail DESIGN.md §7 forbids. stderr still wins
// when both are set — when git has something to say about a failure, that is
// where it says it.
//
// That instance is no longer reachable: m6t stopped running `git commit` in
// #39, and none of pull, push or checkout was observed choosing stdout for a
// failure. It stays anyway, because which stream carries the reason is git's
// decision per subcommand rather than this package's, and the failure mode of
// guessing wrong is silent — an error box with "exit status 1" in it and no way
// to find out what happened. Five lines and a unit test is the cheaper side of
// that trade.
func explanation(stdout, stderr string) string {
	if strings.TrimSpace(stderr) != "" {
		return stderr
	}
	return stdout
}

// argv builds the full argument vector, putting the top-level options where
// git requires them: before the subcommand.
func (call invocation) argv(root string, args []string) []string {
	argv := make([]string, 0, len(args)+3)
	if call.readOnly {
		argv = append(argv, "--no-optional-locks")
	}
	argv = append(argv, "-C", root)
	return append(argv, args...)
}

func (call invocation) deadline() time.Duration {
	if call.network {
		return networkTimeout
	}
	return commandTimeout
}

// commandEnv is the user's environment — git needs it for config, ssh and
// PATH — with two variables pinned.
//
// LC_ALL fixes the locale so git's own messages are the ones
// notARepositoryMessage was written against. GIT_TERMINAL_PROMPT=0 turns a
// credential prompt into a failure rather than a hang: m6t runs git with no
// controlling terminal, so a prompt would have nowhere to appear and the call
// would sit there until its deadline. It disables only git's own prompting —
// credential helpers and ssh-agent are untouched, which is what DESIGN.md §7
// requires of authentication.
func commandEnv() []string {
	return append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0")
}

// classify turns a failed invocation into either a sentinel a caller handles
// or an error carrying git's own stderr.
//
// stderr is passed through verbatim rather than summarized: DESIGN.md §7 is
// explicit that git failures reach the user as git wrote them, because a
// translation loses the detail that makes a git error actionable.
//
// It is a method on the invocation so the timeout it reports is the deadline
// that actually expired. Reading the local constant here regardless of the
// call would tell a user whose push was cut off at ten minutes that it timed
// out after thirty seconds, which is a message that sends them looking for a
// problem they do not have.
func (call invocation) classify(ctx context.Context, err error, argv []string, stderr string) error {
	message := strings.TrimSpace(stderr)

	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == fatalExit &&
		strings.Contains(message, notARepositoryMessage) {
		return ErrNotARepository
	}

	// The literal prefix rather than binaryName: revive's string-format rule
	// reads the format string, and one starting with a verb could be
	// capitalized by its argument as far as the linter can tell.
	command := strings.Join(argv, " ")

	if ctx.Err() != nil {
		return fmt.Errorf("git %s timed out after %s: %s", command, call.deadline(), message)
	}
	if message == "" {
		return fmt.Errorf("git %s: %w", command, err)
	}
	return fmt.Errorf("git %s: %w: %s", command, err, message)
}
