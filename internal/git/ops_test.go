package git

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These drive the real git binary, for the reason run_test.go states: the
// thing under test is whether the argv this package builds is one git accepts
// and acts on. A stub would agree with a wrong flag.

// commitFixture makes a repository with one committed file, the starting point
// most of these need.
func commitFixture(t *testing.T) string {
	t.Helper()
	dir := initRepo(t)
	writeFixtureFile(t, dir, "a.yaml", "one\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "first")
	return dir
}

// statusOf reads the status these tests assert against, failing the test
// rather than returning an error nobody would check.
func statusOf(t *testing.T, dir string) Status {
	t.Helper()
	status, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return status
}

// fileIn finds one path's entry, or the zero value when git did not report it.
func fileIn(status Status, path string) FileStatus {
	for _, f := range status.Files {
		if f.Path == path {
			return f
		}
	}
	return FileStatus{}
}

func TestBranchesListsLocalBranchesOnly(t *testing.T) {
	dir := commitFixture(t)
	runFixtureGit(t, dir, "branch", "feature/x")

	branches, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches: %v", err)
	}

	want := []string{"feature/x", "main"}
	if strings.Join(branches, ",") != strings.Join(want, ",") {
		t.Errorf("branches = %v, want %v", branches, want)
	}
}

// A repository with no commits has no branches to switch to, and the empty
// answer must be a slice: it crosses the bridge as JSON.
func TestBranchesIsEmptyBeforeTheFirstCommit(t *testing.T) {
	branches, err := Branches(initRepo(t))
	if err != nil {
		t.Fatalf("Branches: %v", err)
	}
	if branches == nil {
		t.Fatal("branches is nil; it marshals to null rather than []")
	}
	if len(branches) != 0 {
		t.Errorf("branches = %v, want none", branches)
	}
}

func TestCheckoutSwitchesBranches(t *testing.T) {
	dir := commitFixture(t)
	runFixtureGit(t, dir, "branch", "feature/x")

	if err := Checkout(dir, "feature/x"); err != nil {
		t.Fatalf("Checkout: %v", err)
	}

	if got := statusOf(t, dir).Branch.Name; got != "feature/x" {
		t.Errorf("branch = %q, want feature/x", got)
	}
}

// The trailing `--` earns its place here. With a file and a branch of the same
// name, a checkout without the separator resolves to the *file* and throws the
// user's edits away; with it, git switches branches.
func TestCheckoutPrefersTheBranchOverASameNamedFile(t *testing.T) {
	dir := commitFixture(t)
	runFixtureGit(t, dir, "branch", "release")
	writeFixtureFile(t, dir, "release", "a file, not a branch\n")

	if err := Checkout(dir, "release"); err != nil {
		t.Fatalf("Checkout: %v", err)
	}

	if got := statusOf(t, dir).Branch.Name; got != "release" {
		t.Errorf("branch = %q, want the branch to have been checked out", got)
	}
	if content := readFixtureFile(t, dir, "release"); content != "a file, not a branch\n" {
		t.Errorf("release = %q, want the file untouched", content)
	}
}

func TestCheckoutRejectsANameGitWouldReadAsAnOption(t *testing.T) {
	dir := commitFixture(t)

	for _, name := range []string{"", "-B", "--orphan", "has space", "has\ttab"} {
		if err := Checkout(dir, name); !errors.Is(err, ErrInvalidRef) {
			t.Errorf("Checkout(%q) = %v, want ErrInvalidRef", name, err)
		}
	}
}

func TestCheckoutSurfacesGitsRefusalOnADirtyTree(t *testing.T) {
	dir := commitFixture(t)
	runFixtureGit(t, dir, "branch", "feature/x")
	runFixtureGit(t, dir, "checkout", "-q", "feature/x")
	writeFixtureFile(t, dir, "a.yaml", "on the feature branch\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "diverge")
	runFixtureGit(t, dir, "checkout", "-q", "main")
	writeFixtureFile(t, dir, "a.yaml", "uncommitted\n")

	err := Checkout(dir, "feature/x")
	if err == nil {
		t.Fatal("Checkout overwrote an uncommitted change")
	}
	if !strings.Contains(err.Error(), "would be overwritten") {
		t.Errorf("error = %q, want git's own explanation", err)
	}
}

func TestRemotesListsWhatIsConfigured(t *testing.T) {
	dir := commitFixture(t)
	runFixtureGit(t, dir, "remote", "add", "upstream", "https://example.invalid/r.git")

	remotes, err := Remotes(dir)
	if err != nil {
		t.Fatalf("Remotes: %v", err)
	}
	if len(remotes) != 1 || remotes[0] != "upstream" {
		t.Errorf("remotes = %v, want [upstream]", remotes)
	}
}

func TestRemotesIsEmptyWithNoneConfigured(t *testing.T) {
	remotes, err := Remotes(commitFixture(t))
	if err != nil {
		t.Fatalf("Remotes: %v", err)
	}
	if remotes == nil {
		t.Fatal("remotes is nil; it marshals to null rather than []")
	}
	if len(remotes) != 0 {
		t.Errorf("remotes = %v, want none", remotes)
	}
}

func TestPushRejectsARemoteGitWouldReadAsAnOption(t *testing.T) {
	dir := commitFixture(t)

	for _, remote := range []string{"", "--mirror", "-d", "two words"} {
		if err := Push(dir, remote, true); !errors.Is(err, ErrInvalidRef) {
			t.Errorf("Push(%q, setUpstream) = %v, want ErrInvalidRef", remote, err)
		}
	}
}

// A push with no upstream and no --set-upstream is git's error to explain.
// The remote argument is ignored on that path, which is what lets the UI hold
// a value in its dropdown without it taking effect until the box is ticked —
// note the name here would be rejected by validateRef if it were read.
func TestPushWithoutUpstreamSurfacesGitsRefusal(t *testing.T) {
	dir := commitFixture(t)

	err := Push(dir, "--not-validated-on-this-path", false)
	if err == nil {
		t.Fatal("Push succeeded with no remote configured")
	}
	if errors.Is(err, ErrInvalidRef) {
		t.Fatalf("the remote was validated on a push that does not use it: %v", err)
	}
	// git's own refusal, not a hint elsewhere in its output: the assertion has
	// to fail if this stops carrying what git actually said.
	if !strings.Contains(err.Error(), "No configured push destination") {
		t.Errorf("error = %q, want git's own explanation", err)
	}
	if !strings.Contains(err.Error(), dir) {
		t.Errorf("error = %q, want it to name the repository it ran in", err)
	}
}

// The full loop of the acceptance criteria, against a real remote: commit in
// the worktree the way the terminal agent does, push to a branch with no
// upstream, then pull a commit back. The remote is a bare repository on disk —
// a real git remote over the file transport, so nothing here is stubbed except
// the network.
//
// The commit is made with runFixtureGit rather than through this package,
// because this package no longer records commits (#39): what the loop has to
// prove is that Push and Pull cope with work that arrived from outside m6t,
// which is now the only way work arrives.
func TestTheFullLoopAgainstARemote(t *testing.T) {
	remote := t.TempDir()
	runFixtureGit(t, remote, "init", "-q", "--bare", "-b", "main")

	dir := commitFixture(t)
	runFixtureGit(t, dir, "remote", "add", "origin", remote)

	writeFixtureFile(t, dir, "a.yaml", "one\ntwo\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "edit a.yaml")
	if err := Push(dir, "origin", true); err != nil {
		t.Fatalf("Push --set-upstream: %v", err)
	}

	status := statusOf(t, dir)
	if status.Branch.Upstream != "origin/main" {
		t.Errorf("upstream = %q, want origin/main after --set-upstream", status.Branch.Upstream)
	}

	// A second clone commits and pushes, so there is something to pull back.
	other := t.TempDir()
	runFixtureGit(t, other, "clone", "-q", remote, ".")
	runFixtureGit(t, other, "config", "user.email", "test@example.invalid")
	runFixtureGit(t, other, "config", "user.name", "m6t tests")
	writeFixtureFile(t, other, "b.yaml", "from elsewhere\n")
	runFixtureGit(t, other, "add", "-A")
	runFixtureGit(t, other, "commit", "-qm", "second")
	runFixtureGit(t, other, "push", "-q", "origin", "main")

	if err := Pull(dir); err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if content := readFixtureFile(t, dir, "b.yaml"); content != "from elsewhere\n" {
		t.Errorf("b.yaml = %q, want the pulled content", content)
	}
	if behind := statusOf(t, dir).Branch.Behind; behind != 0 {
		t.Errorf("behind = %d, want 0 after pulling", behind)
	}
}

// divergeFrom builds a repository whose branch and its upstream have each
// committed a different a.yaml — the setup a conflicting pull needs. It
// returns the local worktree.
func divergeFrom(t *testing.T) string {
	t.Helper()
	remote := t.TempDir()
	runFixtureGit(t, remote, "init", "-q", "--bare", "-b", "main")

	dir := commitFixture(t)
	runFixtureGit(t, dir, "remote", "add", "origin", remote)
	runFixtureGit(t, dir, "push", "-q", "-u", "origin", "main")

	other := t.TempDir()
	runFixtureGit(t, other, "clone", "-q", remote, ".")
	runFixtureGit(t, other, "config", "user.email", "test@example.invalid")
	runFixtureGit(t, other, "config", "user.name", "m6t tests")
	writeFixtureFile(t, other, "a.yaml", "theirs\n")
	runFixtureGit(t, other, "add", "-A")
	runFixtureGit(t, other, "commit", "-qm", "theirs")
	runFixtureGit(t, other, "push", "-q", "origin", "main")

	writeFixtureFile(t, dir, "a.yaml", "mine\n")
	runFixtureGit(t, dir, "add", "-A")
	runFixtureGit(t, dir, "commit", "-qm", "mine")
	return dir
}

// The conflict acceptance criterion: a pull that cannot merge fails with git's
// words, and Load then reports the conflicted paths — which is what the UI
// renders and what a resolution in the terminal will clear.
func TestAConflictedPullReportsConflictedPaths(t *testing.T) {
	dir := divergeFrom(t)
	runFixtureGit(t, dir, "config", "pull.rebase", "false")

	if err := Pull(dir); err == nil {
		t.Fatal("Pull reported success on a conflicting merge")
	}

	got := fileIn(statusOf(t, dir), "a.yaml")
	if !got.Conflicted {
		t.Errorf("a.yaml = %+v, want it reported as conflicted", got)
	}
}

// The same divergence with pull.rebase true takes the other branch of the
// repository's own configuration and still stops on the conflict. Pull passes
// neither --rebase nor --no-rebase, so this is the check that it really is the
// repository deciding (DESIGN.md §7) rather than a default this package
// happens to agree with.
func TestPullHonoursARepositoryConfiguredToRebase(t *testing.T) {
	dir := divergeFrom(t)
	runFixtureGit(t, dir, "config", "pull.rebase", "true")

	if err := Pull(dir); err == nil {
		t.Fatal("Pull reported success on a conflicting rebase")
	}

	if got := fileIn(statusOf(t, dir), "a.yaml"); !got.Conflicted {
		t.Errorf("a.yaml = %+v, want it reported as conflicted", got)
	}
	// A rebase in progress is a distinct state from a merge in progress, and
	// the point of not overriding the config is that the user lands in the one
	// their repository asked for.
	if _, err := os.Stat(filepath.Join(dir, ".git", "rebase-merge")); err != nil {
		t.Errorf("no rebase in progress (%v); the repository's pull.rebase was overridden", err)
	}
}

// A repository that has configured neither gets git's own refusal to guess.
// m6t does not answer the question on the user's behalf — a --no-rebase here
// would silently create merge commits in repositories whose owners have not
// decided they want them.
func TestPullLeavesTheReconcileChoiceToGit(t *testing.T) {
	dir := divergeFrom(t)

	err := Pull(dir)
	if err == nil {
		t.Fatal("Pull picked a reconciliation strategy the repository had not configured")
	}
	if !strings.Contains(err.Error(), "divergent branches") {
		t.Errorf("error = %q, want git's own explanation", err)
	}
}

// readFixtureFile reads a file back out of a fixture repository.
func readFixtureFile(t *testing.T, dir, name string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	return string(content)
}
