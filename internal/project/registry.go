package project

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// Registry errors. They are values rather than formatted strings so the binding
// layer can tell "you asked for something that is not registered" from "the
// config file is broken", which are different things to show a user.
var (
	// ErrNotFound reports an operation naming a project the registry does not
	// hold.
	ErrNotFound = errors.New("no such project")

	// ErrNotRepository reports a path that exists but is not a git worktree.
	ErrNotRepository = errors.New("not a git repository")
)

// errIncompleteOrder reports a reorder that does not name every stored project.
//
// It is unexported because nothing outside this package branches on it: the
// binding layer wraps it and the UI shows the sentence, which is all a stale
// tab strip needs to hear before it reloads.
var errIncompleteOrder = errors.New("the stored list holds projects the new order does not name")

// Registry is the persistent list of projects, backed by projects.yaml.
//
// It holds no cached copy of the file. Every operation reads, acts and writes,
// which costs a few milliseconds on a file with tens of entries and removes the
// entire class of bug where the app's idea of the registry and the file's
// contents disagree — including the case where the user edits projects.yaml by
// hand while m6t is running, which DESIGN.md §4 makes a supported thing to do.
type Registry struct {
	// dir is the configuration directory holding this registry's projects.yaml.
	// Every file operation is confined to it (see open).
	dir string

	// mu serializes read-modify-write cycles. Wails dispatches bound calls
	// concurrently, so two tabs adding a project at once is an ordinary event,
	// not a race to be documented away.
	mu sync.Mutex
}

// New builds a registry backed by projects.yaml inside dir.
func New(dir string) *Registry {
	return &Registry{dir: dir}
}

// List returns the registered projects in their stored order, which is the
// order the project tab strip shows and therefore the order the user arranged.
//
// Paths are expanded on the way out: the file holds "~/work/infra" and every
// caller gets an absolute path, so nothing downstream has to know the
// abbreviation exists.
func (r *Registry) List() ([]Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	stored, err := load(r.dir)
	if err != nil {
		return nil, err
	}

	projects := make([]Project, 0, len(stored))
	for _, p := range stored {
		projects = append(projects, resolved(p))
	}
	return projects, nil
}

// Add registers an existing checkout at path under the label displayName.
//
// The path must be a git worktree. That check is the whole validation: m6t
// works on manifest repositories, and a directory that is not one would fail
// later at every git call with a worse message than this one.
//
// displayName is a label, not the key: the project is still filed under a name
// derived from its directory (see uniqueName), and a blank label means the
// project is shown under that name. The label is taken here rather than left to
// a follow-up Update so that a project never appears in the strip under a name
// the user has already replaced.
func (r *Registry) Add(path, displayName string) (Project, error) {
	target, err := resolve(path)
	if err != nil {
		return Project{}, err
	}
	if err := requireRepository(target); err != nil {
		return Project{}, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	return r.append(target, strings.TrimSpace(displayName))
}

// append adds a validated absolute path to the registry. The caller holds mu.
func (r *Registry) append(target, displayName string) (Project, error) {
	projects, err := load(r.dir)
	if err != nil {
		return Project{}, err
	}

	// A repository already registered is returned as it stands rather than
	// added twice. Adding the same checkout under two names would give it two
	// independent kube bindings, and the second one is how a manifest reaches
	// the cluster the user thought they had unbound.
	//
	// It keeps the label it already has, too: adding a repository that is
	// registered is a no-op that selects it, and silently renaming the tab the
	// user named last week is not what "add" promised.
	for _, p := range projects {
		if expand(p.Path) == target {
			return resolved(p), nil
		}
	}

	added := Project{
		Name:        uniqueName(projects, filepath.Base(target)),
		Path:        abbreviate(target),
		DisplayName: displayName,
	}
	if err := save(r.dir, append(projects, added)); err != nil {
		return Project{}, err
	}
	return resolved(added), nil
}

// Remove drops a project from the registry and returns what it removed.
//
// It touches the registry and nothing else. The working tree stays exactly
// where it is — "remove" here means m6t stops listing the repository, and a
// user who wanted the files gone would have said so to something other than a
// project list.
//
// Returning the removed project (path expanded, as List's do) is what lets a
// caller that keyed something else off that path — a watcher, keyed by
// worktree rather than by name (internal/watch) — tear it down without a
// second lookup.
func (r *Registry) Remove(name string) (Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	projects, err := load(r.dir)
	if err != nil {
		return Project{}, err
	}

	var removed Project
	found := false
	remaining := make([]Project, 0, len(projects))
	for _, p := range projects {
		if p.Name == name {
			removed, found = p, true
			continue
		}
		remaining = append(remaining, p)
	}
	if !found {
		return Project{}, fmt.Errorf("removing %s: %w", name, ErrNotFound)
	}
	if err := save(r.dir, remaining); err != nil {
		return Project{}, err
	}
	return resolved(removed), nil
}

// Reorder rewrites the stored order to the one names gives.
//
// The order in projects.yaml IS the order of the tab strip (see List), so
// dragging a tab is a rewrite of the list and nothing else: no project is
// added, removed, renamed or rebound by one.
//
// names must be exactly the registered set. A request that names something else
// is refused rather than reconciled: projects.yaml is editable by hand while
// m6t is running (DESIGN.md §4), so a mismatch means the strip is ordering a
// list that no longer exists, and applying it would silently drop whatever the
// registry gained in the meantime. The caller reloads and the user drags again,
// which costs a gesture; the alternative costs a project.
func (r *Registry) Reorder(names []string) ([]Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	projects, err := load(r.dir)
	if err != nil {
		return nil, err
	}

	remaining := make(map[string]Project, len(projects))
	for _, p := range projects {
		remaining[p.Name] = p
	}

	ordered := make([]Project, 0, len(projects))
	for _, name := range names {
		p, ok := remaining[name]
		if !ok {
			// Either the name is not registered or it appeared twice; both are
			// the same broken request, and both are caught by the delete below
			// having already run.
			return nil, fmt.Errorf("reordering %s: %w", name, ErrNotFound)
		}
		delete(remaining, name)
		ordered = append(ordered, p)
	}
	if len(remaining) != 0 {
		return nil, fmt.Errorf("reordering projects: %w", errIncompleteOrder)
	}

	if err := save(r.dir, ordered); err != nil {
		return nil, err
	}
	for i := range ordered {
		ordered[i] = resolved(ordered[i])
	}
	return ordered, nil
}

// Settings returns the named project's kube binding and helm defaults.
func (r *Registry) Settings(name string) (Settings, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	projects, err := load(r.dir)
	if err != nil {
		return Settings{}, err
	}
	for _, p := range projects {
		if p.Name == name {
			return p.settings(), nil
		}
	}
	return Settings{}, fmt.Errorf("reading settings for %s: %w", name, ErrNotFound)
}

// Update replaces the named project's settings, leaving its name and path
// alone.
//
// Scope paths are validated before anything is written. A binding is the one
// setting whose being wrong reaches a cluster, so a settings write carrying a
// scope that does not name a subtree of the repository is refused whole rather
// than stored with the bad rule dropped — half-applied safety settings are
// worse than a rejected form, because the user believes the half that vanished
// is in force.
func (r *Registry) Update(name string, s Settings) (Project, error) {
	kube, err := validateScopes(s.Kube)
	if err != nil {
		return Project{}, fmt.Errorf("updating %s: %w", name, err)
	}
	s.Kube = kube

	r.mu.Lock()
	defer r.mu.Unlock()

	projects, err := load(r.dir)
	if err != nil {
		return Project{}, err
	}

	for i, p := range projects {
		if p.Name != name {
			continue
		}
		projects[i] = p.withSettings(s)
		if err := save(r.dir, projects); err != nil {
			return Project{}, err
		}
		return resolved(projects[i]), nil
	}
	return Project{}, fmt.Errorf("updating %s: %w", name, ErrNotFound)
}

// resolve turns a user-supplied path into an absolute one, expanding a leading
// "~" and following symlinks.
//
// Symlinks are resolved so that the same checkout reached two ways is one
// project rather than two: /tmp and /private/tmp on macOS are the case that
// makes this not hypothetical.
func resolve(path string) (string, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", errors.New("a project path is required")
	}

	absolute, err := filepath.Abs(expand(trimmed))
	if err != nil {
		return "", fmt.Errorf("resolving %s: %w", trimmed, err)
	}

	// A path that does not exist yet has nothing to evaluate; report it as the
	// missing directory it is rather than as a symlink failure.
	evaluated, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("resolving %s: %w", absolute, err)
	}
	return evaluated, nil
}

// requireRepository fails unless dir is a git worktree.
//
// The test is for a .git entry of either kind: a directory in an ordinary
// clone, a file holding a gitdir pointer in a linked worktree or a submodule.
// Checking only for a directory would reject worktrees, which are exactly the
// setup someone managing several environments of one manifest repo would have.
func requireRepository(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("reading %s: %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("checking %s: %w", dir, ErrNotRepository)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return fmt.Errorf("checking %s: %w", dir, ErrNotRepository)
	}
	return nil
}

// uniqueName returns base, or base with the lowest numeric suffix that no
// existing project holds.
//
// Two checkouts of the same repository under different parents — infra/prod and
// infra/staging both named "infra" — is the ordinary case, not an edge one, and
// a registry keyed by name has to keep them apart.
func uniqueName(projects []Project, base string) string {
	taken := make(map[string]bool, len(projects))
	for _, p := range projects {
		taken[p.Name] = true
	}
	if !taken[base] {
		return base
	}
	for n := 2; ; n++ {
		candidate := base + "-" + strconv.Itoa(n)
		if !taken[candidate] {
			return candidate
		}
	}
}
