package gitexec

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// These tests drive the real `git` binary rather than a fake.
//
// The point of this package is what it establishes around the process — the
// flags, the locale, the deadline, the two sentinels — and a stubbed exec would
// pass every assertion below while the flags were wrong. git is a hard
// requirement of contributing to this repository, so a machine without it fails
// these rather than skipping them: a skip here would be a silent hole in the
// only check that talks to the real tool.

// emptyRepo makes a repository with no commits. Nothing here reads history, so
// there is nothing to commit — what these tests need is a path git agrees is a
// work tree.
func emptyRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.CommandContext(t.Context(), "git", "-C", dir, "init", "-q", "-b", "main")
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: git init: %v\n%s", err, out)
	}
	return dir
}

// The argv this package builds has to be one git accepts, with the top-level
// options in the position git requires. A regression here is invisible to every
// other test: git would still run, it would just start writing .git/index again
// and feed the watcher that triggered it.
func TestReadPassesNoOptionalLocksBeforeTheSubcommand(t *testing.T) {
	dir := emptyRepo(t)

	// git rejects a top-level option given after the subcommand, so a
	// successful call is the assertion that -C and --no-optional-locks are
	// accepted where this package puts them.
	out, err := Read(dir, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if strings.TrimSpace(out) != "true" {
		t.Errorf("rev-parse said %q, want true", strings.TrimSpace(out))
	}
}

// A fatal git error that is NOT one of the two sentinels stays an error, and it
// must carry git's own words: DESIGN.md §7 is explicit that git failures reach
// the user as git wrote them.
func TestReadSurfacesStderrVerbatim(t *testing.T) {
	dir := emptyRepo(t)

	_, err := Read(dir, "status", "--porcelain=v99")
	if err == nil {
		t.Fatal("Read accepted an unsupported porcelain version")
	}
	if errors.Is(err, ErrNotARepository) || errors.Is(err, ErrNoGit) {
		t.Fatalf("a malformed flag was classified as a sentinel: %v", err)
	}
	if !strings.Contains(err.Error(), "porcelain") {
		t.Errorf("error = %q, want it to carry git's own stderr", err)
	}
}

// The sentinel a caller turns into an Availability rather than an error box.
// Matching it depends on git's English message, which is why commandEnv pins
// LC_ALL — see TestCommandEnvDisablesGitsOwnPrompting.
func TestReadReportsANonRepositoryAsASentinel(t *testing.T) {
	_, err := Read(t.TempDir(), "status", "--porcelain=v2")
	if !errors.Is(err, ErrNotARepository) {
		t.Errorf("error = %v, want ErrNotARepository", err)
	}
}

func TestReadReportsAMissingGitAsASentinel(t *testing.T) {
	t.Setenv("PATH", "")

	if _, err := Read(t.TempDir(), "status"); !errors.Is(err, ErrNoGit) {
		t.Errorf("error = %v, want ErrNoGit", err)
	}
}

// A path that has gone away is a failure, not a sentinel: git's complaint is
// about the directory, not about the repository, and there is nothing for a
// status bar to explain in place of it.
func TestReadSurfacesAFailureThatIsNotASentinel(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "was-here")

	_, err := Read(missing, "status", "--porcelain=v2")
	if err == nil {
		t.Fatal("Read succeeded for a path that does not exist")
	}
	if errors.Is(err, ErrNotARepository) {
		t.Errorf("error = %v, want a plain failure rather than the sentinel", err)
	}
	if !strings.Contains(err.Error(), "No such file or directory") {
		t.Errorf("error = %q, want git's own explanation", err)
	}
}

// Write is the mutating path, and it must NOT carry --no-optional-locks.
// Nothing else fails when it does — git accepts the flag on a write and the
// operation still works — so without this the only symptom would be a subtly
// different locking discipline on every write m6t makes.
func TestMutatingInvocationsDoNotSuppressOptionalLocks(t *testing.T) {
	writing := invocation{}.argv("/repo", []string{"checkout", "main", "--"})
	for _, arg := range writing {
		if arg == "--no-optional-locks" {
			t.Fatalf("argv = %v, want no --no-optional-locks on a write", writing)
		}
	}
	if writing[0] != "-C" || writing[1] != "/repo" {
		t.Errorf("argv = %v, want -C first so git resolves the worktree", writing)
	}

	reading := invocation{readOnly: true}.argv("/repo", []string{"status"})
	if reading[0] != "--no-optional-locks" {
		t.Errorf("argv = %v, want --no-optional-locks first on a read", reading)
	}
}

// Write and WriteRemote are separate functions so the deadline is chosen by
// naming the operation. This pins that they choose different ones — a
// WriteRemote that fell back to the local deadline would abort real transfers,
// and nothing in the suite would notice.
func TestWriteRemoteTakesTheLongerDeadline(t *testing.T) {
	if got := (invocation{}).deadline(); got != commandTimeout {
		t.Errorf("local deadline = %s, want %s", got, commandTimeout)
	}
	if got := (invocation{network: true}).deadline(); got != networkTimeout {
		t.Errorf("network deadline = %s, want %s", got, networkTimeout)
	}
	if networkTimeout <= commandTimeout {
		t.Error("the network deadline is not longer than the local one")
	}
}

// A write that fails still reports git's own words, even though Write throws
// its standard output away on success.
func TestWriteCarriesGitsFailureOut(t *testing.T) {
	dir := emptyRepo(t)

	err := Write(dir, "checkout", "no-such-branch", "--")
	if err == nil {
		t.Fatal("Write succeeded checking out a branch that does not exist")
	}
	if !strings.Contains(err.Error(), "no-such-branch") {
		t.Errorf("error = %q, want git's own explanation", err)
	}
}

// WriteRemote has to actually run git, not just pick a deadline. A repository
// with no remote configured makes git refuse before it opens a socket, so this
// reaches the same code path a push does without needing a network.
func TestWriteRemoteRunsGitAndCarriesItsRefusal(t *testing.T) {
	dir := emptyRepo(t)

	err := WriteRemote(dir, "push")
	if err == nil {
		t.Fatal("WriteRemote succeeded pushing a repository with no remote")
	}
	if !strings.Contains(err.Error(), "push") {
		t.Errorf("error = %q, want it to name the command that failed", err)
	}
}

func TestClassifyReportsATimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := invocation{}.classify(ctx, errors.New("signal: killed"), []string{"status"}, "some stderr")
	if err == nil {
		t.Fatal("classify accepted a canceled context as success")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error = %q, want it to name the timeout", err)
	}
	if !strings.Contains(err.Error(), "some stderr") {
		t.Errorf("error = %q, want it to carry stderr", err)
	}
}

// The timeout a call reports must be the deadline that actually expired.
// Reporting the local constant for a network call tells a user whose push was
// cut off after ten minutes that it timed out after thirty seconds, and sends
// them looking for a problem they do not have.
func TestClassifyNamesTheDeadlineThatExpired(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	local := invocation{}.classify(ctx, errors.New("signal: killed"), []string{"checkout"}, "")
	if !strings.Contains(local.Error(), commandTimeout.String()) {
		t.Errorf("local error = %q, want it to name %s", local, commandTimeout)
	}

	remote := invocation{network: true}.classify(ctx, errors.New("signal: killed"), []string{"push"}, "")
	if !strings.Contains(remote.Error(), networkTimeout.String()) {
		t.Errorf("network error = %q, want it to name %s", remote, networkTimeout)
	}
	if strings.Contains(remote.Error(), commandTimeout.String()) {
		t.Errorf("network error = %q, want it not to name the local deadline", remote)
	}
}

func TestClassifyOmitsAnEmptyStderr(t *testing.T) {
	err := invocation{}.classify(context.Background(), errors.New("exit status 1"), []string{"status"}, "   ")
	if err == nil {
		t.Fatal("classify accepted a failure as success")
	}
	if strings.HasSuffix(err.Error(), ": ") {
		t.Errorf("error = %q, want no trailing empty stderr", err)
	}
	if !strings.Contains(err.Error(), "exit status 1") {
		t.Errorf("error = %q, want it to carry the underlying failure", err)
	}
}

// git does not always fail on stderr: `git commit` with an empty index exits
// non-zero and explains itself on stdout. Reporting only stderr would hand the
// user "exit status 1", which is the loss of detail DESIGN.md §7 forbids.
//
// This is the only test of the stdout branch since #39 took `git commit` out of
// m6t — no remaining subcommand was observed picking stdout for a failure. See
// explanation's own comment for why the branch stays.
func TestExplanationFallsBackToStdout(t *testing.T) {
	if got := explanation("nothing to commit\n", ""); got != "nothing to commit\n" {
		t.Errorf("explanation = %q, want stdout when stderr is empty", got)
	}
	if got := explanation("nothing to commit\n", "  \n"); got != "nothing to commit\n" {
		t.Errorf("explanation = %q, want stdout when stderr is only whitespace", got)
	}
	if got := explanation("routine output\n", "the real reason\n"); got != "the real reason\n" {
		t.Errorf("explanation = %q, want stderr to win when both are set", got)
	}
}

// GIT_TERMINAL_PROMPT=0 is what turns an authentication prompt into a failure
// rather than a hang: m6t runs git with no controlling terminal, so a prompt has
// nowhere to appear. Nothing else in the suite would notice its removal — the
// symptom is a call that never returns.
func TestCommandEnvDisablesGitsOwnPrompting(t *testing.T) {
	env := commandEnv()

	var prompt, locale bool
	for _, entry := range env {
		switch entry {
		case "GIT_TERMINAL_PROMPT=0":
			prompt = true
		case "LC_ALL=C":
			locale = true
		}
	}
	if !prompt {
		t.Error("GIT_TERMINAL_PROMPT=0 is absent; a credential prompt would hang the call")
	}
	if !locale {
		t.Error("LC_ALL=C is absent; notARepositoryMessage matches git's English text")
	}
}
