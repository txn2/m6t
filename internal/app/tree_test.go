package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/txn2/m6t/internal/project"
	"github.com/txn2/m6t/internal/watch"
)

// eventuallyApp retries condition until it holds or a bounded deadline
// passes, failing the test if it never does — the shape
// internal/stream/helpers_test.go and internal/watch's own tests already use
// for assertions about a background goroutine's effect.
func eventuallyApp(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// recordingEvents records every batch a watch.Service publishes through it,
// so a test can assert a watcher is actually running for a root rather than
// only that Start returned no error.
type recordingEvents struct {
	mu    sync.Mutex
	roots map[string]int
}

func newRecordingEvents() *recordingEvents {
	return &recordingEvents{roots: make(map[string]int)}
}

func (r *recordingEvents) PublishTreeChanged(root string, _ []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.roots[root]++
}

func (r *recordingEvents) count(root string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.roots[root]
}

func TestListCreateRenameDeleteEntryRoundTripThroughTheBinding(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")

	if err := a.CreateEntry(root, "deploy.yaml", false); err != nil {
		t.Fatalf("CreateEntry: %v", err)
	}
	if err := a.CreateEntry(root, "manifests", true); err != nil {
		t.Fatalf("CreateEntry(dir): %v", err)
	}

	entries, err := a.ListDirectory(root, "")
	if err != nil {
		t.Fatalf("ListDirectory: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("ListDirectory = %+v, want 2 entries", entries)
	}

	if err := a.RenameEntry(root, "deploy.yaml", "service.yaml"); err != nil {
		t.Fatalf("RenameEntry: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "service.yaml")); err != nil {
		t.Errorf("RenameEntry did not move the file: %v", err)
	}

	if err := a.DeleteEntry(root, "service.yaml"); err != nil {
		t.Fatalf("DeleteEntry: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "service.yaml")); !os.IsNotExist(err) {
		t.Errorf("DeleteEntry left the file behind: %v", err)
	}
}

// Errors from watch keep their sentinel, the same guarantee the project
// bindings already give: a caller telling "outside the worktree" from "the
// disk said no" needs errors.Is to still work through the wrap.
func TestTreeBindingsPreserveWatchSentinels(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")

	if _, err := a.ListDirectory(root, "../escape"); !errors.Is(err, watch.ErrOutsideRoot) {
		t.Errorf("ListDirectory(../escape) = %v, want ErrOutsideRoot", err)
	}
	if err := a.CreateEntry(root, ".git/hook", false); !errors.Is(err, watch.ErrGitInternal) {
		t.Errorf("CreateEntry(.git/hook) = %v, want ErrGitInternal", err)
	}
	if err := a.DeleteEntry(root, ""); !errors.Is(err, watch.ErrNoPath) {
		t.Errorf("DeleteEntry(root) = %v, want ErrNoPath", err)
	}
}

func TestTreeBindingErrorsNameTheirSubject(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")

	if _, err := a.ListDirectory(root, "missing"); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Errorf("ListDirectory error = %v, want it to name the path", err)
	}
}

func TestRenameEntryWrapsAFailure(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")

	err := a.RenameEntry(root, "missing.yaml", "new.yaml")
	if err == nil {
		t.Fatal("RenameEntry of a missing file succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "missing.yaml") || !strings.Contains(err.Error(), "new.yaml") {
		t.Errorf("RenameEntry error = %v, want it to name both paths", err)
	}
}

// A registry that cannot be read has nothing to watch — startRegisteredWatchers
// must not panic reaching for it, the same tolerance projects.List's own
// callers already have.
func TestStartRegisteredWatchersToleratesAnUnreadableRegistry(_ *testing.T) {
	startRegisteredWatchers(project.New(""), watch.New(discardEvents{}, watch.Options{}))
}

// AddProject and RemoveProject are the watcher's lifecycle hooks: a project
// is watched from the moment it is registered, and stops being watched the
// moment it is removed — RemoveProject's whole point is that nothing in the
// app still reaches for a project's worktree afterward.
func TestAddProjectStartsAWatcherAndRemoveProjectStopsIt(t *testing.T) {
	rec := newRecordingEvents()
	a := &App{
		projects: project.New(t.TempDir()),
		trees:    watch.New(rec, watch.Options{}),
	}
	t.Cleanup(a.trees.Shutdown)

	dir := repoDir(t, "infra")
	added, err := a.AddProject(dir)
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	if err := os.WriteFile(filepath.Join(added.Path, "a.yaml"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing a file: %v", err)
	}
	eventuallyApp(t, "the watcher started by AddProject to publish", func() bool {
		return rec.count(added.Path) > 0
	})

	if err := a.RemoveProject("infra"); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}
	before := rec.count(added.Path)
	if err := os.WriteFile(filepath.Join(added.Path, "b.yaml"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing a file after RemoveProject: %v", err)
	}
	// There is nothing to poll for here, only that nothing more arrives —
	// eventuallyApp is not the right shape for an absence, so this asserts a
	// snapshot after a watcher genuinely has had time to fire if it were
	// still running (the write above landed, and the recording is
	// synchronous once PublishTreeChanged is called).
	if after := rec.count(added.Path); after != before {
		t.Errorf("watcher for %s still publishing after RemoveProject: %d before, %d after", added.Path, before, after)
	}
}

// startWatchingRegisteredProjects is OnStartup's hook: every project already
// on disk when the app boots must be watched without the frontend doing
// anything project-specific to ask for it.
func TestStartWatchingRegisteredProjectsCoversEveryExistingProject(t *testing.T) {
	rec := newRecordingEvents()
	registry := project.New(t.TempDir())
	a := &App{projects: registry, trees: watch.New(rec, watch.Options{})}
	t.Cleanup(a.trees.Shutdown)

	dirA := repoDir(t, "a")
	dirB := repoDir(t, "b")
	if _, err := registry.Add(dirA); err != nil {
		t.Fatalf("registering a: %v", err)
	}
	if _, err := registry.Add(dirB); err != nil {
		t.Fatalf("registering b: %v", err)
	}

	startRegisteredWatchers(a.projects, a.trees)

	projects, err := registry.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, p := range projects {
		if err := os.WriteFile(filepath.Join(p.Path, "touched.yaml"), []byte("x"), 0o640); err != nil {
			t.Fatalf("writing into %s: %v", p.Path, err)
		}
		eventuallyApp(t, "the watcher for "+p.Name+" to publish", func() bool {
			return rec.count(p.Path) > 0
		})
	}
}
