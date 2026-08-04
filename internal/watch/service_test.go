package watch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServiceStartWatchesAndStopEndsIt(t *testing.T) {
	root := tree(t, nil, []string{"manifests"})
	rec := &recordingEvents{}
	s := New(rec, Options{})

	if err := s.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(s.Shutdown)

	if err := os.WriteFile(filepath.Join(root, "manifests", "a.yaml"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing a file: %v", err)
	}
	eventually(t, "a batch after Start", func() bool {
		return rec.count() > 0
	})

	s.Stop(root)
	before := rec.count()

	if err := os.WriteFile(filepath.Join(root, "manifests", "b.yaml"), []byte("x"), 0o640); err != nil {
		t.Fatalf("writing a file after Stop: %v", err)
	}
	// Absence is asserted with a bounded wait rather than eventually: there is
	// nothing to poll for, only that nothing more arrives in a window long
	// enough to have seen it if Stop had not worked.
	time.Sleep(200 * time.Millisecond)
	if after := rec.count(); after != before {
		t.Errorf("published %d more batches after Stop, want 0", after-before)
	}
}

func TestServiceStartReportsAWatcherThatFailsToStart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	s := New(&recordingEvents{}, Options{Poll: true})
	t.Cleanup(s.Shutdown)

	if err := s.Start(root); err == nil {
		t.Error("Start over a missing root succeeded, want an error")
	}
	if _, tracked := s.watchers[root]; tracked {
		t.Error("a watcher that failed to start is still tracked")
	}
}

func TestServiceStartIsIdempotent(t *testing.T) {
	root := tree(t, nil, nil)
	rec := &recordingEvents{}
	s := New(rec, Options{})
	t.Cleanup(s.Shutdown)

	if err := s.Start(root); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	first := s.watchers[root]

	if err := s.Start(root); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if s.watchers[root] != first {
		t.Error("a second Start replaced the running watcher, want the first left in place")
	}
}

func TestServiceStopOfAnUnwatchedRootIsANoOp(t *testing.T) {
	s := New(&recordingEvents{}, Options{})
	s.Stop("/never/started")
	if len(s.watchers) != 0 {
		t.Errorf("watchers = %d after Stop of an unwatched root, want 0", len(s.watchers))
	}
}

func TestServiceShutdownStopsEveryWatcher(t *testing.T) {
	rootA := tree(t, nil, nil)
	rootB := tree(t, nil, nil)
	rec := &recordingEvents{}
	s := New(rec, Options{})

	if err := s.Start(rootA); err != nil {
		t.Fatalf("Start(rootA): %v", err)
	}
	if err := s.Start(rootB); err != nil {
		t.Fatalf("Start(rootB): %v", err)
	}

	s.Shutdown()

	if len(s.watchers) != 0 {
		t.Errorf("watchers after Shutdown = %d, want 0", len(s.watchers))
	}
}

func TestServiceUsesPollingWhenConfigured(t *testing.T) {
	root := tree(t, nil, nil)
	s := New(&recordingEvents{}, Options{Poll: true})
	t.Cleanup(s.Shutdown)

	if err := s.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, ok := s.watchers[root].(*pollWatcher); !ok {
		t.Errorf("watcher for %s is %T, want *pollWatcher", root, s.watchers[root])
	}
}

func TestServiceDefaultsToFsnotify(t *testing.T) {
	root := tree(t, nil, nil)
	s := New(&recordingEvents{}, Options{})
	t.Cleanup(s.Shutdown)

	if err := s.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if _, ok := s.watchers[root].(*fsWatcher); !ok {
		t.Errorf("watcher for %s is %T, want *fsWatcher", root, s.watchers[root])
	}
}
