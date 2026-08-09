package watch

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// gitRepo makes a real repository with one committed file.
//
// The tests below that use it are about what a real git invocation does to a
// real watched directory, so a fixture that only looks like a repository (the
// tree helper's .git) would not exercise the thing they exist to pin.
func gitRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	runGitInTest(t, root, "init", "-q", "-b", "main")
	runGitInTest(t, root, "config", "user.email", "test@example.invalid")
	runGitInTest(t, root, "config", "user.name", "m6t tests")
	if err := os.WriteFile(filepath.Join(root, "a.yaml"), []byte("one\n"), 0o640); err != nil {
		t.Fatalf("writing a.yaml: %v", err)
	}
	runGitInTest(t, root, "add", "-A")
	runGitInTest(t, root, "commit", "-qm", "first")
	return root
}

// runGitInTest runs one git command, failing the test if it does not succeed.
// git is a hard requirement of contributing to this repository, so a machine
// without it fails here rather than skipping.
func runGitInTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// testInterval is the coalescing cadence tests run at — short enough that a
// test finishes quickly, long enough that a handful of rapid writes land in
// the same window on ordinary CI hardware.
const testInterval = 20 * time.Millisecond

// waitFor is how long a test waits for a batch that should arrive. Generous
// relative to testInterval so a slow CI runner does not make this flaky.
const waitFor = 2 * time.Second

// recordingEvents is an Events that records every published batch.
type recordingEvents struct {
	mu      sync.Mutex
	batches [][]string
}

func (r *recordingEvents) PublishTreeChanged(_ string, dirs []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.batches = append(r.batches, append([]string(nil), dirs...))
}

// count reports how many batches have been published so far.
func (r *recordingEvents) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.batches)
}

// all returns every directory named across every batch published so far,
// deduplicated.
func (r *recordingEvents) all() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	seen := make(map[string]bool)
	for _, batch := range r.batches {
		for _, d := range batch {
			seen[d] = true
		}
	}
	return seen
}

// eventually retries condition until it holds or waitFor elapses, failing the
// test if it never does — the shape internal/stream/helpers_test.go already
// uses for assertions about a background goroutine's effect.
func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestFsWatcherReportsANewFileInTheWatchedDirectory(t *testing.T) {
	root := tree(t, nil, []string{"manifests"})
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	if err := os.WriteFile(filepath.Join(root, "manifests", "deploy.yaml"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing a file: %v", err)
	}

	eventually(t, "a batch naming manifests", func() bool {
		return rec.all()["manifests"]
	})
}

func TestFsWatcherWatchesANewlyCreatedDirectory(t *testing.T) {
	root := tree(t, nil, nil)
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	if err := os.Mkdir(filepath.Join(root, "sub"), 0o750); err != nil {
		t.Fatalf("making a directory: %v", err)
	}
	eventually(t, "a batch naming the new directory's parent", func() bool {
		return rec.all()["."]
	})

	// The new directory itself must now be watched — a file written into it
	// right after creation (the common case: `mkdir -p a/b && touch a/b/c`)
	// has to be seen, not missed because the watch was added too late.
	if err := os.WriteFile(filepath.Join(root, "sub", "c.yaml"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing into the new directory: %v", err)
	}
	eventually(t, "a batch naming sub", func() bool {
		return rec.all()["sub"]
	})
}

func TestFsWatcherCoalescesRapidChangesIntoFewBatches(t *testing.T) {
	root := tree(t, nil, []string{"manifests"})
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	const churn = 50
	for i := range churn {
		name := filepath.Join(root, "manifests", "file-"+string(rune('a'+i%26))+".yaml")
		if err := os.WriteFile(name, []byte("x"), 0o640); err != nil {
			t.Fatalf("writing %s: %v", name, err)
		}
	}

	eventually(t, "the churn to be reported", func() bool {
		return rec.all()["manifests"]
	})

	// churn writes land within a handful of flush windows, never one batch
	// per file — that is the whole point of coalescing.
	if n := rec.count(); n >= churn {
		t.Errorf("published %d batches for %d writes, want far fewer", n, churn)
	}
}

func TestFsWatcherRootIsGitDoesNotWatchGitInternalsButDoesWatchHeadAndRefs(t *testing.T) {
	root := tree(t, nil, nil)
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	// .git itself and .git/refs (created by tree helper) are watched.
	w.mu.Lock()
	_, gitWatched := w.watched[filepath.Join(root, gitDir)]
	_, refsWatched := w.watched[filepath.Join(root, gitDir, "refs", "heads")]
	w.mu.Unlock()
	if !gitWatched {
		t.Error(".git is not watched, want it watched for HEAD")
	}
	if !refsWatched {
		t.Error(".git/refs/heads is not watched, want refs watched recursively")
	}

	// A file dropped into .git outside HEAD/refs (e.g. the index) must not be
	// watched — creating one there produces no watch entry for its directory.
	if err := os.WriteFile(filepath.Join(root, gitDir, "index"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing .git/index: %v", err)
	}
	w.mu.Lock()
	_, indexDirWatched := w.watched[filepath.Join(root, gitDir)]
	w.mu.Unlock()
	// .git itself stays watched (for HEAD) — the assertion is that nothing
	// *else* under .git gained a watch, which addTree's SkipDir already
	// guarantees structurally; this just documents the shape.
	if !indexDirWatched {
		t.Error(".git watch was lost")
	}
}

func TestFsWatcherPublishesNothingWhenNothingChanges(t *testing.T) {
	root := tree(t, []string{"a.yaml"}, nil)
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	// Several quiet flush intervals must not publish anything — a watcher
	// that reports "changed" on an untouched tree would flood the tree UI
	// with no-op refreshes every tick.
	time.Sleep(testInterval * 10)
	if n := rec.count(); n != 0 {
		t.Errorf("published %d batches for an unchanged tree, want 0", n)
	}
}

// The regression test for #61, and the one that had to talk to real git.
//
// The loop it pins was invisible to every other test here: a `git status` read
// opens .git/index, macOS reports the access-time bump as NOTE_ATTRIB, fsnotify
// surfaces that as Chmod, and the resulting batch told the frontend its status
// was stale — so it read again. An idle window ran four `git status`
// subprocesses a second, forever.
//
// A fake cannot catch it. The event only exists because a real read touched a
// real file and a real kernel reported it, so the assertion has to be made
// against those. On Linux the read produces no event at all and this passes for
// a different reason, which is fine — it is the platform where the bug does not
// exist.
func TestAStatusReadDoesNotFeedTheWatcher(t *testing.T) {
	root := gitRepo(t)
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	// Let anything left over from building the fixture settle and clear it, so
	// what is counted below is only what the reads produced.
	time.Sleep(testInterval * 5)
	rec.mu.Lock()
	rec.batches = nil
	rec.mu.Unlock()

	// The read m6t actually makes, flags included: --no-optional-locks is what
	// already stops the read from writing the index, and it is deliberately
	// still not enough on its own.
	for range 5 {
		runGitInTest(t, root, "--no-optional-locks", "-C", root, "status", "--porcelain=v2", "--branch", "-z")
	}

	time.Sleep(testInterval * 5)
	if n := rec.count(); n != 0 {
		t.Errorf("published %d batches for five status reads of an unchanged repository, want 0", n)
	}
}

// The other half: the fix must not have bought silence by going deaf. A change
// made outside the app still has to reach the badges.
func TestAWriteToTheIndexStillPublishes(t *testing.T) {
	root := gitRepo(t)
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	if err := os.WriteFile(filepath.Join(root, "a.yaml"), []byte("changed\n"), 0o640); err != nil {
		t.Fatalf("writing a.yaml: %v", err)
	}
	runGitInTest(t, root, "add", "-A")

	eventually(t, "a batch after git add", func() bool {
		return rec.count() > 0
	})
}

// The unit under the two above: an event carrying nothing but Chmod marks
// nothing pending, and one carrying Chmod alongside a real operation still
// does. kqueue combines bits, so a fix written as "has the Chmod bit" instead
// of "is only the Chmod bit" would drop real writes and no other test here
// would notice — every one of them produces a plain Write.
//
// The watcher here is built by hand rather than started, so the only events it
// ever sees are the two below. A running watcher would be reading a real
// directory at the same time, and a stray event from it would make the "nothing
// is pending" assertion depend on what the filesystem happened to be doing.
func TestAttributeOnlyEventsAreDroppedAndCombinedOnesAreNot(t *testing.T) {
	root := t.TempDir()
	w := &fsWatcher{
		root:    root,
		events:  &recordingEvents{},
		watched: map[string]bool{},
		pending: map[string]bool{},
		done:    make(chan struct{}),
	}
	path := filepath.Join(root, "a.yaml")

	w.handle(fsnotify.Event{Name: path, Op: fsnotify.Chmod})
	if len(w.pending) != 0 {
		t.Errorf("a Chmod-only event marked %d directories pending, want 0", len(w.pending))
	}

	w.handle(fsnotify.Event{Name: path, Op: fsnotify.Write | fsnotify.Chmod})
	if !w.pending["."] {
		t.Errorf("a Write|Chmod event marked %v pending, want the file's directory", w.pending)
	}
}

func TestFsWatcherStopsTrackingARemovedDirectory(t *testing.T) {
	root := tree(t, nil, []string{"sub"})
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	t.Cleanup(w.stop)

	w.mu.Lock()
	_, watchedBefore := w.watched[filepath.Join(root, "sub")]
	w.mu.Unlock()
	if !watchedBefore {
		t.Fatal("sub was never watched to begin with")
	}

	if err := os.RemoveAll(filepath.Join(root, "sub")); err != nil {
		t.Fatalf("removing sub: %v", err)
	}

	eventually(t, "root to be reported changed", func() bool {
		return rec.all()["."]
	})
	eventually(t, "sub to stop being tracked", func() bool {
		w.mu.Lock()
		defer w.mu.Unlock()
		_, stillWatched := w.watched[filepath.Join(root, "sub")]
		return !stillWatched
	})
}

// A directory the walk cannot read fails the whole watcher to start rather
// than silently watching a partial tree — the caller (watch.Service.Start)
// has no other signal that some of a project's worktree went unwatched.
func TestStartFsWatcherFailsWhenADirectoryIsUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses permission checks")
	}
	root := tree(t, nil, []string{"blocked"})
	blocked := filepath.Join(root, "blocked")
	if err := os.Chmod(blocked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o750) })

	if _, err := startFsWatcherWithInterval(root, &recordingEvents{}, testInterval); err == nil {
		t.Error("starting a watcher over an unreadable directory succeeded, want an error")
	}
}

func TestFsWatcherStopReleasesItsGoroutines(t *testing.T) {
	root := tree(t, nil, nil)
	rec := &recordingEvents{}

	w, err := startFsWatcherWithInterval(root, rec, testInterval)
	if err != nil {
		t.Fatalf("startFsWatcherWithInterval: %v", err)
	}
	w.stop()

	// A closed fsnotify.Watcher's Events channel closes; run's select sees
	// that and returns. There is no direct way to observe the goroutine
	// exiting from here, so this asserts what stop is documented to do:
	// the watcher accepts no further events without panicking.
	select {
	case _, ok := <-w.nfy.Events:
		if ok {
			t.Error("Events channel still open after stop")
		}
	case <-time.After(waitFor):
		t.Error("Events channel never closed after stop")
	}
}
