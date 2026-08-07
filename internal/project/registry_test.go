package project

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
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

	added, err := r.Add(dir, "")
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

	if _, err := r.Add(plain, ""); !errors.Is(err, ErrNotRepository) {
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

	if _, err := r.Add(dir, ""); err != nil {
		t.Errorf("Add of a linked worktree: %v, want it accepted", err)
	}
}

func TestAddRejectsAMissingPathAndAnEmptyOne(t *testing.T) {
	r := newRegistry(t)

	if _, err := r.Add(filepath.Join(t.TempDir(), "nope"), ""); err == nil {
		t.Error("Add of a missing path succeeded, want an error")
	}
	if _, err := r.Add("   ", ""); err == nil {
		t.Error("Add of a blank path succeeded, want an error")
	}
}

func TestAddRejectsAFile(t *testing.T) {
	r := newRegistry(t)
	file := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("creating a file: %v", err)
	}

	if _, err := r.Add(file, ""); !errors.Is(err, ErrNotRepository) {
		t.Errorf("Add of a regular file = %v, want ErrNotRepository", err)
	}
}

// Registering the same checkout twice would give one repository two kube
// bindings, and the second is how a manifest reaches a cluster the user thought
// they had unbound.
func TestAddIsIdempotentForTheSameCheckout(t *testing.T) {
	r := newRegistry(t)
	dir, resolved := fakeRepo(t, "infra")

	first, err := r.Add(dir, "")
	if err != nil {
		t.Fatalf("first Add: %v", err)
	}
	second, err := r.Add(dir, "")
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

	if _, err := r.Add(first, ""); err != nil {
		t.Fatalf("first Add: %v", err)
	}
	got2, err := r.Add(second, "")
	if err != nil {
		t.Fatalf("second Add: %v", err)
	}
	got3, err := r.Add(third, "")
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
		if _, err := r.Add(dir, ""); err != nil {
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
	if _, err := r.Add(dir, ""); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if _, err := r.Remove("infra"); err != nil {
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
		if _, err := r.Add(dir, ""); err != nil {
			t.Fatalf("Add %s: %v", name, err)
		}
	}

	if _, err := r.Remove("beta"); err != nil {
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
	if _, err := newRegistry(t).Remove("ghost"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Remove of an unregistered project = %v, want ErrNotFound", err)
	}
}

func TestUpdateReplacesSettingsAndPersists(t *testing.T) {
	dir := tempConfigDir(t)
	r := New(dir)
	repo, resolved := fakeRepo(t, "infra")
	if _, err := r.Add(repo, ""); err != nil {
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
	if !reflect.DeepEqual(updated.Kube, want.Kube) {
		t.Errorf("returned kube = %+v, want %+v", updated.Kube, want.Kube)
	}
	if updated.Path != resolved {
		t.Errorf("returned path = %q, want the expanded %q", updated.Path, resolved)
	}

	reloaded, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings after reload: %v", err)
	}
	if !reflect.DeepEqual(reloaded.Kube, want.Kube) {
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
	if _, err := r.Add(dir, ""); err != nil {
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

// The label the add flow collects has to arrive with the registration: a tab
// that showed "k8s" until a follow-up rename landed is the problem the label
// exists to solve (#41).
func TestAddStoresTheDisplayNameWithoutTouchingTheKey(t *testing.T) {
	dir := tempConfigDir(t)
	r := New(dir)
	repo, _ := fakeRepo(t, "k8s")

	added, err := r.Add(repo, "  Production infra  ")
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if added.DisplayName != "Production infra" {
		t.Errorf("display name = %q, want it trimmed to %q", added.DisplayName, "Production infra")
	}
	if added.Name != "k8s" {
		t.Errorf("name = %q, want the key still derived from the directory", added.Name)
	}

	reloaded, err := New(dir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(reloaded) != 1 || reloaded[0].DisplayName != "Production infra" {
		t.Errorf("after reload = %+v, want the display name persisted", reloaded)
	}
}

// A project already registered keeps the label the user gave it. Re-adding a
// checkout selects it; it does not rename the tab out from under them.
func TestAddLeavesAnExistingProjectsLabelAlone(t *testing.T) {
	r := newRegistry(t)
	repo, _ := fakeRepo(t, "k8s")
	if _, err := r.Add(repo, "Production"); err != nil {
		t.Fatalf("first Add: %v", err)
	}

	second, err := r.Add(repo, "Something else")
	if err != nil {
		t.Fatalf("second Add: %v", err)
	}
	if second.DisplayName != "Production" {
		t.Errorf("display name after re-adding = %q, want the original %q", second.DisplayName, "Production")
	}
}

// The label and the color are settings, so Update carries them — and carries
// them without disturbing the binding that shares the struct.
func TestUpdateRenamesAndColoursWithoutLosingTheBinding(t *testing.T) {
	dir := tempConfigDir(t)
	r := New(dir)
	repo, _ := fakeRepo(t, "k8s")
	if _, err := r.Add(repo, ""); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, err := r.Update("k8s", Settings{Kube: Kube{Context: "prod-us-west"}}); err != nil {
		t.Fatalf("binding the context: %v", err)
	}

	updated, err := r.Update("k8s", Settings{
		DisplayName: " Production ",
		Color:       " amber ",
		Kube:        Kube{Context: "prod-us-west"},
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.DisplayName != "Production" || updated.Color != "amber" {
		t.Errorf("updated = %+v, want the label and color trimmed and stored", updated)
	}

	// The acceptance criterion: it survives a restart.
	reloaded, err := New(dir).Settings("k8s")
	if err != nil {
		t.Fatalf("Settings after reload: %v", err)
	}
	if reloaded.DisplayName != "Production" || reloaded.Color != "amber" {
		t.Errorf("settings after reload = %+v, want the label and color", reloaded)
	}
	if reloaded.Kube.Context != "prod-us-west" {
		t.Errorf("kube context after a rename = %q, want it untouched", reloaded.Kube.Context)
	}
}

// A registry written before this ticket has neither field. It must load as
// defaults and must not gain keys it did not have.
func TestARegistryWithoutTheNewFieldsRoundTrips(t *testing.T) {
	dir := tempConfigDir(t)
	const stored = "projects:\n    - name: infra\n      path: /w/infra\n"
	if err := os.WriteFile(registryFile(dir), []byte(stored), configPerm); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	listed, err := New(dir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 1 || listed[0].DisplayName != "" || listed[0].Color != "" {
		t.Errorf("List = %+v, want the new fields defaulted to empty", listed)
	}

	// A write that touches nothing else must reproduce the file as it was.
	if _, err := New(dir).Reorder([]string{"infra"}); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	raw, err := os.ReadFile(registryFile(dir))
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if string(raw) != stored {
		t.Errorf("rewritten registry =\n%s\nwant it unchanged:\n%s", raw, stored)
	}
}

// The stored order is the tab strip's order, so a drag is a rewrite of the
// list — and the arrangement has to survive a restart.
func TestReorderRewritesTheStoredOrder(t *testing.T) {
	dir := tempConfigDir(t)
	r := New(dir)
	for _, name := range []string{"alpha", "beta", "gamma"} {
		repo, _ := fakeRepo(t, name)
		if _, err := r.Add(repo, ""); err != nil {
			t.Fatalf("Add %s: %v", name, err)
		}
	}

	ordered, err := r.Reorder([]string{"gamma", "alpha", "beta"})
	if err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	if names(ordered) != "gamma,alpha,beta" {
		t.Errorf("returned order = %v, want [gamma alpha beta]", names(ordered))
	}
	if ordered[0].Path != expand(ordered[0].Path) {
		t.Errorf("returned path %q is not expanded", ordered[0].Path)
	}

	reloaded, err := New(dir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if names(reloaded) != "gamma,alpha,beta" {
		t.Errorf("order after reload = %v, want [gamma alpha beta]", names(reloaded))
	}
}

// projects.yaml is editable by hand while m6t runs, so a strip can order a list
// that no longer exists. Applying it would drop whatever the registry gained in
// the meantime, which is a project lost to a drag.
func TestReorderRefusesAnOrderThatIsNotTheStoredSet(t *testing.T) {
	setup := func(t *testing.T) *Registry {
		t.Helper()
		r := newRegistry(t)
		for _, name := range []string{"alpha", "beta"} {
			repo, _ := fakeRepo(t, name)
			if _, err := r.Add(repo, ""); err != nil {
				t.Fatalf("Add %s: %v", name, err)
			}
		}
		return r
	}

	tests := map[string]struct {
		order []string
		want  error
	}{
		"a project the registry does not hold": {order: []string{"alpha", "beta", "ghost"}, want: ErrNotFound},
		"a project named twice":                {order: []string{"alpha", "alpha"}, want: ErrNotFound},
		"a project left out":                   {order: []string{"alpha"}, want: errIncompleteOrder},
		"nothing at all":                       {order: nil, want: errIncompleteOrder},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			r := setup(t)
			if _, err := r.Reorder(tt.order); !errors.Is(err, tt.want) {
				t.Fatalf("Reorder(%v) = %v, want %v", tt.order, err, tt.want)
			}
			// A refused reorder must leave the registry exactly as it was.
			listed, err := r.List()
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if names(listed) != "alpha,beta" {
				t.Errorf("order after a refused reorder = %v, want it unchanged", names(listed))
			}
		})
	}
}

func TestReorderReportsABrokenOrUnwritableRegistry(t *testing.T) {
	broken := tempConfigDir(t)
	if err := os.WriteFile(registryFile(broken), []byte("projects: [oh: dear: no\n"), configPerm); err != nil {
		t.Fatalf("seeding: %v", err)
	}
	if _, err := New(broken).Reorder([]string{"infra"}); err == nil {
		t.Error("Reorder over a malformed config succeeded, want an error")
	}

	dir := tempConfigDir(t)
	r := New(dir)
	repo, _ := fakeRepo(t, "infra")
	if _, err := r.Add(repo, ""); err != nil {
		t.Fatalf("seeding: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, tempFile), 0o750); err != nil {
		t.Fatalf("occupying the scratch name: %v", err)
	}
	if _, err := r.Reorder([]string{"infra"}); err == nil {
		t.Error("Reorder with an unwritable registry succeeded, want an error")
	}
}

// names renders a project list as a comparable string.
func names(projects []Project) string {
	got := make([]string, 0, len(projects))
	for _, p := range projects {
		got = append(got, p.Name)
	}
	return strings.Join(got, ",")
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
			_, err := r.Add(dir, "")
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
		"Add":      func() error { _, err := r.Add(repo, ""); return err },
		"Remove":   func() error { _, err := r.Remove("anything"); return err },
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

	if _, err := r.Add(repo, ""); err == nil {
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
	if _, err := r.Add(repo, ""); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	// A directory in the scratch file's place makes the write fail without
	// touching the registry the read already succeeded on.
	if err := os.MkdirAll(filepath.Join(dir, tempFile), 0o750); err != nil {
		t.Fatalf("occupying the scratch name: %v", err)
	}

	writes := map[string]func() error{
		"Add":    func() error { second, _ := fakeRepo(t, "other"); _, err := r.Add(second, ""); return err },
		"Remove": func() error { _, err := r.Remove("infra"); return err },
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

// requireRepository is reached through Add, which resolves the path first and
// so never hands it something missing. Its own stat failure therefore needs
// driving directly — otherwise the branch is unreachable and untested.
func TestRequireRepositoryReportsAnUnreadablePath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent")

	if err := requireRepository(missing); err == nil {
		t.Error("requireRepository on a missing path succeeded, want an error")
	}
}

// A settings write carrying a scope that does not name a subtree of the
// repository is refused whole, at the registry rather than only at the binding
// layer. Storing it with the bad rule dropped would leave the user believing a
// folder is bound to something it is not.
func TestUpdateRefusesAScopeOutsideTheRepositoryAndWritesNothing(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	repo, _ := fakeRepo(t, "infra")
	r := New(dir)
	if _, err := r.Add(repo, ""); err != nil {
		t.Fatalf("Add: %v", err)
	}

	_, err := r.Update("infra", Settings{Kube: Kube{
		Context:   "prod-us-west",
		Namespace: "default",
		Scopes:    []Scope{{Path: "../elsewhere", Context: "somewhere-else"}},
	}})
	if !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("Update with an escaping scope error = %v, want ErrInvalidScope", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if stored.Kube.Context != "" || stored.Kube.Scopes != nil {
		t.Errorf("stored binding after a refused update = %+v, want the project still unbound", stored.Kube)
	}
}

// The scopes that survive are the normalized ones, and they round-trip through
// projects.yaml as written: a binding the file disagrees with is a binding the
// next launch gets wrong.
func TestUpdateStoresNormalizedScopes(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	repo, _ := fakeRepo(t, "infra")
	r := New(dir)
	if _, err := r.Add(repo, ""); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if _, err := r.Update("infra", Settings{Kube: Kube{
		Context:   "prod-us-west",
		Namespace: "default",
		Scopes: []Scope{
			{Path: " ./dev/ ", Context: "dev-cluster", Namespace: "dev"},
			{Path: "prod/api", Namespace: "api", Protected: true},
		},
	}}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings after reload: %v", err)
	}
	want := []Scope{
		{Path: "dev", Context: "dev-cluster", Namespace: "dev"},
		{Path: "prod/api", Namespace: "api", Protected: true},
	}
	if !reflect.DeepEqual(stored.Kube.Scopes, want) {
		t.Errorf("scopes after reload = %+v, want %+v", stored.Kube.Scopes, want)
	}

	// And they resolve the way the layout says they should.
	got := stored.Kube.Resolve("prod/api/deployment.yaml")
	if got != (Binding{Context: "prod-us-west", Namespace: "api", Protected: true, Scope: "prod/api"}) {
		t.Errorf("resolved binding after reload = %+v", got)
	}
}

// boundRegistry registers a project carrying the dev/prod layout and returns
// the registry it lives in.
func boundRegistry(t *testing.T) (r *Registry, dir string) {
	t.Helper()

	dir = t.TempDir()
	repo, _ := fakeRepo(t, "infra")
	r = New(dir)
	if _, err := r.Add(repo, ""); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, err := r.Update("infra", Settings{Kube: Kube{
		Context:   "prod-us-west",
		Namespace: "default",
		Scopes:    []Scope{{Path: "dev", Context: "dev-cluster", Namespace: "dev"}},
	}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	return r, dir
}

func TestBindScopeAddsAnOverrideAndLeavesTheRestAlone(t *testing.T) {
	t.Parallel()

	r, dir := boundRegistry(t)

	if _, err := r.BindScope("infra", Scope{Path: "prod/api", Namespace: "api", Protected: true}); err != nil {
		t.Fatalf("BindScope: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if len(stored.Kube.Scopes) != 2 {
		t.Fatalf("scopes = %+v, want the existing one plus the new one", stored.Kube.Scopes)
	}
	if stored.Kube.Context != "prod-us-west" || stored.Kube.Namespace != "default" {
		t.Errorf("project default changed to %+v", stored.Kube)
	}
	got := stored.Kube.Resolve("prod/api/x.yaml")
	if got != (Binding{Context: "prod-us-west", Namespace: "api", Protected: true, Scope: "prod/api"}) {
		t.Errorf("resolved = %+v", got)
	}
}

// Binding a folder that already has an override replaces it. Two rules for one
// subtree have no winner a user could predict, which is why validateScopes
// refuses them — so the set has to be a replace rather than an append.
func TestBindScopeReplacesAnExistingOverride(t *testing.T) {
	t.Parallel()

	r, dir := boundRegistry(t)

	if _, err := r.BindScope("infra", Scope{Path: "./dev/", Context: "dev2", Namespace: "sandbox"}); err != nil {
		t.Fatalf("BindScope: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	want := []Scope{{Path: "dev", Context: "dev2", Namespace: "sandbox"}}
	if !reflect.DeepEqual(stored.Kube.Scopes, want) {
		t.Errorf("scopes = %+v, want the one override replaced: %+v", stored.Kube.Scopes, want)
	}
}

func TestBindScopeRefusesAPathOutsideTheRepository(t *testing.T) {
	t.Parallel()

	r, dir := boundRegistry(t)

	if _, err := r.BindScope("infra", Scope{Path: "../elsewhere", Context: "x"}); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("BindScope with an escaping path error = %v, want ErrInvalidScope", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if len(stored.Kube.Scopes) != 1 {
		t.Errorf("scopes after a refused bind = %+v, want the original one alone", stored.Kube.Scopes)
	}
}

func TestUnbindScopeRemovesAnOverride(t *testing.T) {
	t.Parallel()

	r, dir := boundRegistry(t)

	if _, err := r.UnbindScope("infra", "dev"); err != nil {
		t.Fatalf("UnbindScope: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if stored.Kube.Scopes != nil {
		t.Errorf("scopes = %+v, want none", stored.Kube.Scopes)
	}
	// And the folder is back to inheriting.
	if got := stored.Kube.Resolve("dev/x.yaml"); got.Context != "prod-us-west" {
		t.Errorf("resolved after unbind = %+v, want the project default", got)
	}
}

// The dialog offers "remove" against what it last read. A folder someone
// unbound in another window in the meantime has arrived where the user asked.
func TestUnbindScopeIsSilentAboutAnOverrideThatIsNotThere(t *testing.T) {
	t.Parallel()

	r, _ := boundRegistry(t)

	if _, err := r.UnbindScope("infra", "staging"); err != nil {
		t.Errorf("UnbindScope on an unbound folder returned %v, want no error", err)
	}
}

func TestScopeWritesReportAnUnknownProject(t *testing.T) {
	t.Parallel()

	r, _ := boundRegistry(t)

	if _, err := r.BindScope("nothing", Scope{Path: "dev"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("BindScope on an unregistered project error = %v, want ErrNotFound", err)
	}
	if _, err := r.UnbindScope("nothing", "dev"); !errors.Is(err, ErrNotFound) {
		t.Errorf("UnbindScope on an unregistered project error = %v, want ErrNotFound", err)
	}
}

// A form saved with nothing filled in says "inherit everything", which is what
// having no override means. Storing it would leave the tree marking a folder as
// bound while it resolved exactly as its parent does.
func TestBindScopeWithNoOverridesRemovesInstead(t *testing.T) {
	t.Parallel()

	r, dir := boundRegistry(t)

	if _, err := r.BindScope("infra", Scope{Path: "dev"}); err != nil {
		t.Fatalf("BindScope: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if stored.Kube.Scopes != nil {
		t.Errorf("scopes = %+v, want the override gone rather than emptied", stored.Kube.Scopes)
	}
}

// The same on a folder that had none: nothing to remove, and nothing stored.
func TestBindScopeWithNoOverridesStoresNothingNew(t *testing.T) {
	t.Parallel()

	r, dir := boundRegistry(t)

	if _, err := r.BindScope("infra", Scope{Path: "staging", Context: "  "}); err != nil {
		t.Fatalf("BindScope: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if len(stored.Kube.Scopes) != 1 || stored.Kube.Scopes[0].Path != "dev" {
		t.Errorf("scopes = %+v, want only the one that was already there", stored.Kube.Scopes)
	}
}

// Protection alone IS an override: a folder that only ratchets confirmation on
// is the prod directory of a repository whose default is unprotected.
func TestBindScopeKeepsAProtectionOnlyOverride(t *testing.T) {
	t.Parallel()

	r, dir := boundRegistry(t)

	if _, err := r.BindScope("infra", Scope{Path: "prod", Protected: true}); err != nil {
		t.Fatalf("BindScope: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	got := stored.Kube.Resolve("prod/x.yaml")
	want := Binding{Context: "prod-us-west", Namespace: "default", Protected: true, Scope: "prod"}
	if got != want {
		t.Errorf("resolved = %+v, want %+v", got, want)
	}
}

// A folder can be bound before the project has any default at all: a user who
// only cares about one directory should not have to bind the whole checkout to
// say so.
func TestBindScopeWorksOnAProjectWithNoDefault(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	repo, _ := fakeRepo(t, "infra")
	r := New(dir)
	if _, err := r.Add(repo, ""); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if _, err := r.BindScope("infra", Scope{Path: "dev", Context: "dev-cluster", Namespace: "dev"}); err != nil {
		t.Fatalf("BindScope: %v", err)
	}

	stored, err := New(dir).Settings("infra")
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if got := stored.Kube.Resolve("dev/x.yaml"); !got.Bound() {
		t.Errorf("dev resolves to %+v, want the folder's own binding", got)
	}
	if got := stored.Kube.Resolve("other/x.yaml"); got.Bound() {
		t.Errorf("an unbound folder resolves to %+v, want unbound", got)
	}
}
