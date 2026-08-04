package project

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRepo creates a directory that passes the worktree check and returns the
// path the registry will store for it — symlinks resolved, because that is what
// Add does and macOS temp directories are symlinked.
func fakeRepo(t *testing.T, name string) (dir, resolved string) {
	t.Helper()
	dir = filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o750); err != nil {
		t.Fatalf("creating a fake repository: %v", err)
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("resolving %s: %v", dir, err)
	}
	return dir, resolved
}

// newRegistry returns a registry backed by a fresh, empty projects.yaml.
func newRegistry(t *testing.T) *Registry {
	t.Helper()
	return New(tempConfigDir(t))
}

func TestAddRegistersAnExistingCheckout(t *testing.T) {
	r := newRegistry(t)
	dir, resolved := fakeRepo(t, "infra")

	added, err := r.Add(dir)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if added.Name != "infra" {
		t.Errorf("name = %q, want the directory's basename %q", added.Name, "infra")
	}
	if added.Path != resolved {
		t.Errorf("path = %q, want the resolved absolute path %q", added.Path, resolved)
	}

	listed, err := r.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 1 || listed[0].Name != "infra" || listed[0].Path != resolved {
		t.Errorf("List = %+v, want the project just added", listed)
	}
}

func TestAddRejectsADirectoryThatIsNotARepository(t *testing.T) {
	r := newRegistry(t)
	plain := filepath.Join(t.TempDir(), "not-a-repo")
	if err := os.MkdirAll(plain, 0o750); err != nil {
		t.Fatalf("creating a plain directory: %v", err)
	}

	if _, err := r.Add(plain); !errors.Is(err, ErrNotRepository) {
		t.Errorf("Add of a plain directory = %v, want ErrNotRepository", err)
	}
}

// A linked worktree and a submodule both carry .git as a FILE. Checking only
// for a directory would reject exactly the multi-environment setup this app is
// for.
func TestAddAcceptsAWorktreeWhoseGitIsAFile(t *testing.T) {
	r := newRegistry(t)
	dir := filepath.Join(t.TempDir(), "linked")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatalf("creating the worktree: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: /elsewhere/.git/worktrees/linked\n"), 0o600); err != nil {
		t.Fatalf("writing the gitdir pointer: %v", err)
	}

	if _, err := r.Add(dir); err != nil {
		t.Errorf("Add of a linked worktree: %v, want it accepted", err)
	}
}

func TestAddRejectsAMissingPathAndAnEmptyOne(t *testing.T) {
	r := newRegistry(t)

	if _, err := r.Add(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("Add of a missing path succeeded, want an error")
	}
	if _, err := r.Add("   "); err == nil {
		t.Error("Add of a blank path succeeded, want an error")
	}
}

func TestAddRejectsAFile(t *testing.T) {
	r := newRegistry(t)
	file := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("creating a file: %v", err)
	}

	if _, err := r.Add(file); !errors.Is(err, ErrNotRepository) {
		t.Errorf("Add of a regular file = %v, want ErrNotRepository", err)
	}
}

// Registering the same checkout twice would give one repository two kube
// bindings, and the second is how a manifest reaches a cluster the user thought
// they had unbound.
func TestAddIsIdempotentForTheSameCheckout(t *testing.T) {
	r := newRegistry(t)
	dir, resolved := fakeRepo(t, "infra")

	first, err := r.Add(dir)
	if err != nil {
		t.Fatalf("first Add: %v", err)
	}
	second, err := r.Add(dir)
	if err != nil {
		t.Fatalf("second Add: %v", err)
	}

	if second.Name != first.Name || second.Path != resolved {
		t.Errorf("second Add returned %+v, want the existing %+v", second, first)
	}
	listed, err := r.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 1 {
		t.Errorf("registry holds %d projects after adding the same checkout twice, want 1", len(listed))
	}
}

// Two checkouts of one repository under different parents is the ordinary case
// for someone managing several environments, and a registry keyed by name has
// to keep them apart.
func TestAddDisambiguatesCollidingNames(t *testing.T) {
	r := newRegistry(t)
	first, _ := fakeRepo(t, "infra")
	second, _ := fakeRepo(t, "infra")
	third, _ := fakeRepo(t, "infra")

	if _, err := r.Add(first); err != nil {
		t.Fatalf("first Add: %v", err)
	}
	got2, err := r.Add(second)
	if err != nil {
		t.Fatalf("second Add: %v", err)
	}
	got3, err := r.Add(third)
	if err != nil {
		t.Fatalf("third Add: %v", err)
	}

	if got2.Name != "infra-2" {
		t.Errorf("second name = %q, want infra-2", got2.Name)
	}
	if got3.Name != "infra-3" {
		t.Errorf("third name = %q, want infra-3", got3.Name)
	}
}

// The stored order is the order the tab strip shows, so it is the user's
// arrangement and must survive a reload.
func TestListPreservesInsertionOrderAcrossReload(t *testing.T) {
	dir := tempConfigDir(t)
	r := New(dir)

	for _, name := range []string{"alpha", "beta", "gamma"} {
		dir, _ := fakeRepo(t, name)
		if _, err := r.Add(dir); err != nil {
			t.Fatalf("Add %s: %v", name, err)
		}
	}

	// A second registry over the same file is what an app restart looks like.
	listed, err := New(dir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	got := make([]string, 0, len(listed))
	for _, p := range listed {
		got = append(got, p.Name)
	}
	if strings.Join(got, ",") != "alpha,beta,gamma" {
		t.Errorf("order after reload = %v, want [alpha beta gamma]", got)
	}
}

// The file holds "~/…" and every caller gets an absolute path; nothing
// downstream should have to know the abbreviation exists.
func TestListExpandsStoredPaths(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skipf("no home directory on this machine: %v", err)
	}
	dir := tempConfigDir(t)
	if err := save(dir, []Project{{Name: "infra", Path: "~/workspace/infra"}}); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	listed, err := New(dir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := filepath.Join(home, "workspace", "infra")
	if len(listed) != 1 || listed[0].Path != want {
		t.Errorf("List path = %+v, want %q", listed, want)
	}
}

func TestListReportsAMalformedConfig(t *testing.T) {
	dir := tempConfigDir(t)
	if err := os.WriteFile(registryFile(dir), []byte("projects: [oh: dear: no\n"), configPerm); err != nil {
		t.Fatalf("seeding: %v", err)
	}
	if _, err := New(dir).List(); err == nil {
		t.Error("List over a malformed config succeeded, want an error")
	}
}

func TestRemoveDropsTheProjectAndLeavesTheWorkingTree(t *testing.T) {
	r := newRegistry(t)
	dir, _ := fakeRepo(t, "infra")
	if _, err := r.Add(dir); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if err := r.Remove("infra"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	listed, err := r.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 0 {
		t.Errorf("registry holds %+v after Remove, want empty", listed)
	}
	// The acceptance criterion this ticket is actually judged on.
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		t.Errorf("Remove touched the working tree at %s: %v", dir, err)
	}
}

func TestRemoveKeepsTheOtherProjects(t *testing.T) {
	r := newRegistry(t)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		dir, _ := fakeRepo(t, name)
		if _, err := r.Add(dir); err != nil {
			t.Fatalf("Add %s: %v", name, err)
		}
	}

	if err := r.Remove("beta"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	listed, err := r.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := make([]string, 0, len(listed))
	for _, p := range listed {
		got = append(got, p.Name)
	}
	if strings.Join(got, ",") != "alpha,gamma" {
		t.Errorf("after removing beta the registry holds %v, want [alpha gamma]", got)
	}
}

func TestRemoveUnknownProjectIsNotFound(t *testing.T) {
	if err := newRegistry(t).Remove("ghost"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Remove of an unregistered project = %v, want ErrNotFound", err)
	}
}

func TestUpdateReplacesSettingsAndPersists(t *testing.T) {
	dir := tempConfigDir(t)
	r := New(dir)
	repo, resolved := fakeRepo(t, "infra")
	if _, err := r.Add(repo); err != nil {
		t.Fatalf("Add: %v", err)
	}

	want := Settings{
		Kube: Kube{Context: "prod-us-west", Namespace: "platform", Protected: true},
		Helm: Helm{DefaultValues: []string{"values.yaml"}},
	}
	updated, err := r.Update("infra", want)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Kube != want.Kube {
		t.Errorf("returned kube = %+v, want %+v", updated.Kube, want.Kube)
	}
	if updated.Path != resolved {
		t.Errorf("returned path = %q, want the expanded %q", updated.Path, resolved)
	}

	reloaded, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings after reload: %v", err)
	}
	if reloaded.Kube != want.Kube {
		t.Errorf("kube binding after reload = %+v, want %+v", reloaded.Kube, want.Kube)
	}
	if strings.Join(reloaded.Helm.DefaultValues, ",") != "values.yaml" {
		t.Errorf("helm defaults after reload = %v, want [values.yaml]", reloaded.Helm.DefaultValues)
	}
}

// Identity is not a setting. An update that could move a project on disk or
// rename it would be a relocation wearing the name of editing a namespace.
func TestUpdateLeavesIdentityAlone(t *testing.T) {
	r := newRegistry(t)
	dir, resolved := fakeRepo(t, "infra")
	if _, err := r.Add(dir); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if _, err := r.Update("infra", Settings{Kube: Kube{Context: "staging"}}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	listed, err := r.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 1 || listed[0].Name != "infra" || listed[0].Path != resolved {
		t.Errorf("identity after Update = %+v, want name infra at %q", listed, resolved)
	}
}

func TestUpdateAndSettingsRejectUnknownProjects(t *testing.T) {
	r := newRegistry(t)
	if _, err := r.Update("ghost", Settings{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("Update of an unregistered project = %v, want ErrNotFound", err)
	}
	if _, err := r.Settings("ghost"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Settings of an unregistered project = %v, want ErrNotFound", err)
	}
}

func TestUniqueNameSkipsEveryTakenSuffix(t *testing.T) {
	projects := []Project{{Name: "infra"}, {Name: "infra-2"}, {Name: "infra-3"}}
	if got := uniqueName(projects, "infra"); got != "infra-4" {
		t.Errorf("uniqueName = %q, want infra-4", got)
	}
	if got := uniqueName(projects, "other"); got != "other" {
		t.Errorf("uniqueName for an unused base = %q, want other", got)
	}
}

// Wails dispatches bound calls concurrently, so two tabs adding at once is
// ordinary. Run with -race, which is how `make test` runs.
func TestConcurrentAddsAllLand(t *testing.T) {
	r := newRegistry(t)
	const count = 8

	dirs := make([]string, count)
	for i := range dirs {
		dirs[i], _ = fakeRepo(t, "repo")
	}

	errs := make(chan error, count)
	for _, dir := range dirs {
		go func() {
			_, err := r.Add(dir)
			errs <- err
		}()
	}
	for range count {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent Add: %v", err)
		}
	}

	listed, err := r.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != count {
		t.Errorf("registry holds %d projects after %d concurrent adds, want %d", len(listed), count, count)
	}

	names := map[string]bool{}
	for _, p := range listed {
		if names[p.Name] {
			t.Errorf("duplicate project name %q survived concurrent adds", p.Name)
		}
		names[p.Name] = true
	}
}

// Every operation reads before it acts, so a config the user has broken must
// stop all of them — not just the one that happens to be tested elsewhere.
// An operation that silently treated a broken file as empty would overwrite it.
func TestEveryOperationRefusesAMalformedConfig(t *testing.T) {
	dir := tempConfigDir(t)
	if err := os.WriteFile(registryFile(dir), []byte("projects: [oh: dear: no\n"), configPerm); err != nil {
		t.Fatalf("seeding: %v", err)
	}
	r := New(dir)
	repo, _ := fakeRepo(t, "infra")

	operations := map[string]func() error{
		"List":     func() error { _, err := r.List(); return err },
		"Add":      func() error { _, err := r.Add(repo); return err },
		"Remove":   func() error { return r.Remove("anything") },
		"Settings": func() error { _, err := r.Settings("anything"); return err },
		"Update":   func() error { _, err := r.Update("anything", Settings{}); return err },
	}

	for name, call := range operations {
		t.Run(name, func(t *testing.T) {
			if err := call(); err == nil {
				t.Errorf("%s over a malformed config succeeded, want an error", name)
			}
		})
	}

	// The file must be exactly as the user left it.
	raw, err := os.ReadFile(registryFile(dir))
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if string(raw) != "projects: [oh: dear: no\n" {
		t.Errorf("a refused operation rewrote the user's config as:\n%s", raw)
	}
}

// A registry whose file cannot be written reports it rather than reporting
// success for a change that did not persist.
func TestAddReportsAnUnwritableRegistry(t *testing.T) {
	repo, _ := fakeRepo(t, "infra")
	r := New(filepath.Join(t.TempDir(), "absent-dir"))

	if _, err := r.Add(repo); err == nil {
		t.Error("Add against an unwritable registry succeeded, want an error")
	}
}

// A registry whose file cannot be written must report it rather than returning
// success for a change that did not persist. The read succeeds — the directory
// is real and the file parses — so only the write can fail, which is the path
// these cover.
func TestWritesReportAFailedSave(t *testing.T) {
	dir := tempConfigDir(t)
	r := New(dir)
	repo, _ := fakeRepo(t, "infra")
	if _, err := r.Add(repo); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	// A directory in the scratch file's place makes the write fail without
	// touching the registry the read already succeeded on.
	if err := os.MkdirAll(filepath.Join(dir, tempFile), 0o750); err != nil {
		t.Fatalf("occupying the scratch name: %v", err)
	}

	writes := map[string]func() error{
		"Add":    func() error { second, _ := fakeRepo(t, "other"); _, err := r.Add(second); return err },
		"Remove": func() error { return r.Remove("infra") },
		"Update": func() error { _, err := r.Update("infra", Settings{Kube: Kube{Context: "x"}}); return err },
	}

	for name, call := range writes {
		t.Run(name, func(t *testing.T) {
			if err := call(); err == nil {
				t.Errorf("%s with an unwritable registry succeeded, want an error", name)
			}
		})
	}

	// The registry the user had must survive a failed write untouched.
	listed, err := New(dir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 1 || listed[0].Name != "infra" {
		t.Errorf("registry after failed writes = %+v, want the original single project", listed)
	}
}
