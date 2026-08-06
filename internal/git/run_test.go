package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The tests below drive the real `git` binary rather than a fake.
//
// The parser has fixture tests (status_test.go) precisely so this file does
// not need many: what is left here is the part a fixture cannot check — that
// the argv this package builds is one git actually accepts, and that the two
// conditions Load turns into states are the ones git really produces. A
// stubbed exec would pass both while the flags were wrong.
//
// git is a hard requirement of contributing to this repository, so a machine
// without it fails these rather than skipping them: a skip here would be a
// silent hole in the one check that talks to the real tool.

// initRepo makes an empty repository with a deterministic identity, so a
// contributor's own git config cannot change what these tests see.
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runFixtureGit(t, dir, "init", "-q", "-b", "main")
	runFixtureGit(t, dir, "config", "user.email", "test@example.invalid")
	runFixtureGit(t, dir, "config", "user.name", "m6t tests")
	return dir
}

// runFixtureGit runs one git command while building a fixture repository.
func runFixtureGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func writeFixtureFile(t *testing.T, dir, name, content string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("creating %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// The flags Load passes have to be flags this git accepts. A fixture test
// cannot catch a typo in them; this one fails outright.
func TestLoadReadsACleanRepository(t *testing.T) {
	dir := initRepo(t)
	writeFixtureFile(t, dir, "a.yaml", "one\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "first")

	status, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if status.Availability != Available {
		t.Errorf("availability = %q, want %q", status.Availability, Available)
	}
	if status.Branch.Name != "main" {
		t.Errorf("branch = %q, want main", status.Branch.Name)
	}
	if status.Branch.Unborn {
		t.Error("unborn = true on a repository with a commit")
	}
	if len(status.Files) != 0 {
		t.Errorf("files = %+v, want none", status.Files)
	}
}

func TestLoadReportsWorkingTreeChanges(t *testing.T) {
	dir := initRepo(t)
	writeFixtureFile(t, dir, "nested/a.yaml", "one\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "first")
	writeFixtureFile(t, dir, "nested/a.yaml", "one\ntwo\n")
	writeFixtureFile(t, dir, "new.md", "fresh\n")

	status, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	byPath := map[string]FileStatus{}
	for _, f := range status.Files {
		byPath[f.Path] = f
	}
	if got := byPath["nested/a.yaml"]; got.Worktree != StateModified {
		t.Errorf("nested/a.yaml = %+v, want a worktree modification", got)
	}
	if got := byPath["new.md"]; got.Worktree != StateUntracked {
		t.Errorf("new.md = %+v, want untracked", got)
	}
}

// A repository with no commits is the state right after `git init`, and it is
// a real project the workbench has to render rather than an error.
func TestLoadReadsARepositoryWithNoCommits(t *testing.T) {
	dir := initRepo(t)

	status, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !status.Branch.Unborn {
		t.Errorf("unborn = false on a repository with no commits: %+v", status.Branch)
	}
	if status.Branch.Name != "main" {
		t.Errorf("branch = %q, want main", status.Branch.Name)
	}
}

// The acceptance criterion: a path that is not a repository is a state the UI
// can render, not an error it has to show in a box.
func TestLoadReportsANonRepositoryAsAState(t *testing.T) {
	status, err := Load(t.TempDir())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if status.Availability != NotARepository {
		t.Errorf("availability = %q, want %q", status.Availability, NotARepository)
	}
	if status.Files == nil {
		t.Error("files is nil; it crosses the bridge as JSON and must marshal to []")
	}
}

// The other degraded state: git is not installed at all.
func TestLoadReportsAMissingGitAsAState(t *testing.T) {
	t.Setenv("PATH", "")

	status, err := Load(t.TempDir())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if status.Availability != NoGit {
		t.Errorf("availability = %q, want %q", status.Availability, NoGit)
	}
	if status.Files == nil {
		t.Error("files is nil; it crosses the bridge as JSON and must marshal to []")
	}
}

// A fatal git error that is NOT "not a repository" must stay an error, and it
// must carry git's own words: DESIGN.md §7 is explicit that git failures reach
// the user as git wrote them.
func TestRunGitSurfacesStderrVerbatim(t *testing.T) {
	dir := initRepo(t)

	_, err := runGit(dir, "status", "--porcelain=v99")
	if err == nil {
		t.Fatal("runGit accepted an unsupported porcelain version")
	}
	if errors.Is(err, errNotARepository) || errors.Is(err, errNoGit) {
		t.Fatalf("a malformed flag was classified as a degraded state: %v", err)
	}
	if !strings.Contains(err.Error(), "porcelain") {
		t.Errorf("error = %q, want it to carry git's own stderr", err)
	}
}

// A path that has gone away is a failure, not a degraded state: git's
// complaint is about the directory, not about the repository, and there is
// nothing for the status bar to explain in place of it.
func TestLoadSurfacesAFailureThatIsNotADegradedState(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "was-here")

	status, err := Load(missing)
	if err == nil {
		t.Fatalf("Load succeeded for a path that does not exist: %+v", status)
	}
	if !strings.Contains(err.Error(), "No such file or directory") {
		t.Errorf("error = %q, want git's own explanation", err)
	}
}

// The argv git is handed must contain the flags this package relies on, in
// the top-level position git requires. A regression here is invisible to
// every other test: git would still run, it would just start writing
// .git/index again and feed the watcher that triggered it.
func TestRunGitPassesNoOptionalLocksBeforeTheSubcommand(t *testing.T) {
	dir := initRepo(t)

	// The proof that -C and --no-optional-locks are accepted where this
	// package puts them: git rejects a top-level option given after the
	// subcommand, so a successful call is the assertion.
	out, err := runGit(dir, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		t.Fatalf("runGit: %v", err)
	}
	if strings.TrimSpace(out) != "true" {
		t.Errorf("rev-parse said %q, want true", strings.TrimSpace(out))
	}
}

func TestClassifyReportsATimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := classify(ctx, errors.New("signal: killed"), []string{"status"}, "some stderr")
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

// A mutating call must NOT carry --no-optional-locks. Nothing else fails when
// it does — git accepts the flag on a write and the operation still works —
// so without this the only symptom would be a subtly different locking
// discipline on every write m6t makes.
func TestMutatingInvocationsDoNotSuppressOptionalLocks(t *testing.T) {
	writing := invocation{}.argv("/repo", []string{"add", "--", "a.yaml"})
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

func TestNetworkInvocationsGetTheLongerDeadline(t *testing.T) {
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

// git does not always fail on stderr: `git commit` with an empty index exits
// non-zero and explains itself on stdout. Reporting only stderr would hand the
// user "exit status 1", which is the loss of detail DESIGN.md §7 forbids.
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
// rather than a hang: m6t runs git with no controlling terminal, so a prompt
// has nowhere to appear. Nothing else in the suite would notice its removal —
// the symptom is a call that never returns.
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

func TestClassifyOmitsAnEmptyStderr(t *testing.T) {
	err := classify(context.Background(), errors.New("exit status 1"), []string{"status"}, "   ")
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
