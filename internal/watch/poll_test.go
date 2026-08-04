package watch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWalkSnapshotExcludesGit(t *testing.T) {
	root := tree(t, []string{"a.yaml", "sub/b.yaml"}, nil)

	snapshot, err := walkSnapshot(root)
	if err != nil {
		t.Fatalf("walkSnapshot: %v", err)
	}
	if _, ok := snapshot[gitDir]; ok {
		t.Errorf("snapshot contains %q, want .git excluded", gitDir)
	}
	if got, want := snapshot["."], []string{"sub", "a.yaml"}; !equalNames(got, want) {
		t.Errorf("snapshot[.] = %v, want %v", got, want)
	}
	if got, want := snapshot["sub"], []string{"b.yaml"}; !equalNames(got, want) {
		t.Errorf("snapshot[sub] = %v, want %v", got, want)
	}
}

func TestWalkSnapshotDescendsMultipleLevels(t *testing.T) {
	root := tree(t, []string{"sub/nested/c.yaml"}, nil)

	snapshot, err := walkSnapshot(root)
	if err != nil {
		t.Fatalf("walkSnapshot: %v", err)
	}
	if got, want := snapshot["sub/nested"], []string{"c.yaml"}; !equalNames(got, want) {
		t.Errorf("snapshot[sub/nested] = %v, want %v", got, want)
	}
}

func TestStartPollWatcherFailsOverANonexistentRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")

	if _, err := startPollWatcherWithInterval(root, &recordingEvents{}, testInterval); err == nil {
		t.Error("starting a poll watcher over a missing root succeeded, want an error")
	}
}

// A directory the walk cannot read fails the snapshot outright rather than
// silently reporting a partial tree.
func TestWalkSnapshotFailsWhenADirectoryIsUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses permission checks")
	}
	root := tree(t, nil, []string{"blocked"})
	blocked := filepath.Join(root, "blocked")
	if err := os.Chmod(blocked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o750) })

	if _, err := walkSnapshot(root); err == nil {
		t.Error("walkSnapshot over an unreadable directory succeeded, want an error")
	}
}

func TestDiffSnapshotsReportsAddedRemovedAndChangedDirectories(t *testing.T) {
	before := map[string][]string{
		".":   {"sub"},
		"sub": {"a.yaml"},
	}
	after := map[string][]string{
		".":     {"other", "sub"},
		"sub":   {"a.yaml", "b.yaml"},
		"other": {},
	}

	changed := diffSnapshots(before, after)
	want := map[string]bool{".": true, "sub": true, "other": true}
	if len(changed) != len(want) {
		t.Fatalf("diffSnapshots = %v, want %v", changed, want)
	}
	for _, d := range changed {
		if !want[d] {
			t.Errorf("unexpected changed dir %q", d)
		}
	}
}

func TestDiffSnapshotsReportsARemovedDirectory(t *testing.T) {
	before := map[string][]string{
		".":    {"gone"},
		"gone": {"a.yaml"},
	}
	after := map[string][]string{
		".": {},
	}

	changed := diffSnapshots(before, after)
	want := map[string]bool{".": true, "gone": true}
	if len(changed) != len(want) {
		t.Fatalf("diffSnapshots = %v, want %v", changed, want)
	}
}

func TestDiffSnapshotsReportsNothingWhenUnchanged(t *testing.T) {
	snapshot := map[string][]string{
		".":   {"sub"},
		"sub": {"a.yaml"},
	}
	if changed := diffSnapshots(snapshot, snapshot); len(changed) != 0 {
		t.Errorf("diffSnapshots of an unchanged snapshot = %v, want none", changed)
	}
}

func TestPollWatcherReportsAChange(t *testing.T) {
	root := tree(t, nil, []string{"manifests"})
	rec := &recordingEvents{}

	w, err := startPollWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startPollWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	if err := os.WriteFile(filepath.Join(root, "manifests", "deploy.yaml"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing a file: %v", err)
	}

	eventually(t, "a batch naming manifests", func() bool {
		return rec.all()["manifests"]
	})
}

func TestPollWatcherReportsNothingWhenQuiet(t *testing.T) {
	root := tree(t, []string{"a.yaml"}, nil)
	rec := &recordingEvents{}

	w, err := startPollWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startPollWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	// Several quiet polling intervals must not publish anything — a poller
	// that reports "changed" on an unchanged tree would flood the tree UI
	// with no-op refreshes every tick.
	time.Sleep(testInterval * 10)
	if n := rec.count(); n != 0 {
		t.Errorf("published %d batches for an unchanged tree, want 0", n)
	}
}
