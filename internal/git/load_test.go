package git

import (
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
// the flags Load asks for are ones git actually accepts, and that the two
// conditions Load turns into states are the ones git really produces. A
// stubbed exec would pass both while the flags were wrong.
//
// What the runner itself establishes — the argv shape, the locale, the
// deadlines, the sentinels — is tested where it lives, in internal/gitexec.
// This file asserts only what Load does with the answers.
//
// git is a hard requirement of contributing to this repository, so a machine
// without it fails these rather than skipping them: a skip here would be a
// silent hole in the one check that talks to the real tool.
//
// initRepo, runFixtureGit and writeFixtureFile are the package's shared fixture
// builders; ops_test.go, status_test.go and blame_test.go all use them.

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
