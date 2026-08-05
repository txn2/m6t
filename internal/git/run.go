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

// commandTimeout bounds one invocation.
//
// A read-only status on a cold, very large repository can take seconds, so
// this is generous. What it is actually for is the case with no other exit:
// git blocked on an unreachable network mount, or waiting on a lock a crashed
// process left behind. Without a deadline that call never returns and the
// project's badges never update again.
const commandTimeout = 30 * time.Second

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

// runGit invokes git inside root and returns its standard output.
//
// The argv is a slice and the binary is executed directly — never a shell —
// so a worktree path containing shell metacharacters is inert
// (.semgrep/go-security.yml enforces the no-shell half of this). The argv is
// logged, as CLAUDE.md requires of every external binary: what the app ran on
// the user's repository is the first thing anyone debugging it needs, and it
// is only ever written when something actually changed on disk, so an idle
// project logs nothing.
func runGit(root string, args ...string) (string, error) {
	binary, err := exec.LookPath(binaryName)
	if err != nil {
		return "", errNoGit
	}

	// --no-optional-locks stops git from refreshing the index as a side
	// effect of reading it. It is what keeps this package from feeding
	// itself: the watcher that triggers a status also watches .git, so an
	// invocation that wrote .git/index would publish a change, which would
	// trigger another invocation, forever.
	argv := append([]string{"--no-optional-locks", "-C", root}, args...)
	log.Printf("m6t: running %s %s", binary, strings.Join(argv, " "))

	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, binary, argv...)

	// The user's environment is inherited — git needs it for config, ssh and
	// PATH — with the locale pinned so git's own messages are the ones
	// notARepositoryMessage was written against.
	cmd.Env = append(os.Environ(), "LC_ALL=C")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", classify(ctx, err, argv, stderr.String())
	}
	return stdout.String(), nil
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
