package git

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
// Matching on message text is only sound because runGit forces LC_ALL=C: with
// a translated locale this string would be whatever the user's language calls
// it, and the check would silently stop matching.
const notARepositoryMessage = "not a git repository"

// Sentinels for the two conditions Load turns into an Availability rather
// than an error. They are unexported: outside this package they are not
// errors at all, they are fields on Status.
var (
	errNoGit          = errors.New("git was not found on PATH")
	errNotARepository = errors.New("not a git repository")
)

// invocation is how one git call differs from the default one.
//
// The zero value is a mutating, local call with no input — the shape every
// operation in ops.go wants — so only the exceptions have to say anything.
type invocation struct {
	// readOnly adds --no-optional-locks, which stops git from refreshing the
	// index as a side effect of reading it. It is what keeps the status
	// reader from feeding itself: the watcher that triggers a status also
	// watches .git, so a read that wrote .git/index would publish a change,
	// which would trigger another read, forever.
	//
	// A mutating call must NOT set it. Those write the index on purpose, and
	// the resulting event is the notification the UI needs to refresh.
	readOnly bool

	// network extends the deadline to networkTimeout for a call that talks to
	// a remote.
	network bool

	// stdin is fed to git and closed. It carries a commit message, which is
	// the one input too large and too free-form to be an argv element.
	stdin string
}

// runGit invokes git inside root as a read-only call and returns its standard
// output. It is the status reader's entry point; ops.go calls runWith.
func runGit(root string, args ...string) (string, error) {
	return runWith(root, invocation{readOnly: true}, args...)
}

// runWith invokes git inside root and returns its standard output.
//
// The argv is a slice and the binary is executed directly — never a shell —
// so a worktree path containing shell metacharacters is inert
// (.semgrep/go-security.yml enforces the no-shell half of this). The argv is
// logged, as CLAUDE.md requires of every external binary: what the app ran on
// the user's repository is the first thing anyone debugging it needs. stdin is
// deliberately not logged — it is a commit message, which is the user's prose
// and not part of what was run.
func runWith(root string, call invocation, args ...string) (string, error) {
	binary, err := exec.LookPath(binaryName)
	if err != nil {
		return "", errNoGit
	}

	argv := call.argv(root, args)
	log.Printf("m6t: running %s %s", binary, strings.Join(argv, " "))

	ctx, cancel := context.WithTimeout(context.Background(), call.deadline())
	defer cancel()

	cmd := exec.CommandContext(ctx, binary, argv...)
	cmd.Env = commandEnv()
	// Always a reader, never the inherited stdin: a git that reached the
	// user's terminal would be reading keystrokes meant for a shell in
	// another pane. An operation with no input gets an empty one, which is
	// what makes a remote asking for a password fail instead of hang.
	cmd.Stdin = strings.NewReader(call.stdin)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", classify(ctx, err, argv, explanation(stdout.String(), stderr.String()))
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

// classify turns a failed invocation into either a sentinel this package
// handles or an error carrying git's own stderr.
//
// stderr is passed through verbatim rather than summarized: DESIGN.md §7 is
// explicit that git failures reach the user as git wrote them, because a
// translation loses the detail that makes a git error actionable.
func classify(ctx context.Context, err error, argv []string, stderr string) error {
	message := strings.TrimSpace(stderr)

	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == fatalExit &&
		strings.Contains(message, notARepositoryMessage) {
		return errNotARepository
	}

	// The literal prefix rather than binaryName: revive's string-format rule
	// reads the format string, and one starting with a verb could be
	// capitalized by its argument as far as the linter can tell.
	command := strings.Join(argv, " ")

	if ctx.Err() != nil {
		return fmt.Errorf("git %s timed out after %s: %s", command, commandTimeout, message)
	}
	if message == "" {
		return fmt.Errorf("git %s: %w", command, err)
	}
	return fmt.Errorf("git %s: %w: %s", command, err, message)
}
