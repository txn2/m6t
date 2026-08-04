package watch

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// coalesceInterval is how often pending directory changes are flushed to
// Events.
//
// A fixed cadence rather than a resetting debounce (github.com/bep/debounce,
// already pulled in transitively by Wails, was considered and rejected for
// this): a debounce that resets on every call would never fire while a
// branch switch is still touching files, which is exactly the "mass file
// churn" case the issue's acceptance criteria call out. A ticker always
// flushes on schedule, which is what keeps the ~1s reflection target true
// during a storm and not only in the quiet-repository case, and bounds
// publishes to at most 1/coalesceInterval per second regardless of how many
// raw filesystem events land in between.
const coalesceInterval = 250 * time.Millisecond

// fsWatcher watches one project's worktree with fsnotify, recursively.
//
// It watches every directory under root except the contents of .git, with
// two exceptions: .git itself (to see HEAD change) and .git/refs,
// recursively (to see branch pointers move). Nothing in this package acts on
// those events specially yet — they flow through the same coalesced batches
// as everything else, and stay invisible to the tree UI because List refuses
// .git — but the watch exists now so #8 (git status badges, DESIGN.md §3.2)
// only has to start listening rather than add its own watch.
type fsWatcher struct {
	root   string
	events Events
	nfy    *fsnotify.Watcher

	mu      sync.Mutex
	watched map[string]bool // native OS directory paths currently watched
	pending map[string]bool // root-relative, slash-separated dirs changed since the last flush

	done chan struct{}
}

// startFsWatcher walks root, adds a recursive watch, and begins publishing
// coalesced change batches at the default cadence.
func startFsWatcher(root string, events Events) (*fsWatcher, error) {
	return startFsWatcherWithInterval(root, events, coalesceInterval)
}

// startFsWatcherWithInterval is startFsWatcher with the flush cadence
// exposed, so a test can observe coalescing without waiting out the real
// interval.
func startFsWatcherWithInterval(root string, events Events, interval time.Duration) (*fsWatcher, error) {
	nfy, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("starting a filesystem watcher for %s: %w", root, err)
	}

	w := &fsWatcher{
		root:    root,
		events:  events,
		nfy:     nfy,
		watched: make(map[string]bool),
		pending: make(map[string]bool),
		done:    make(chan struct{}),
	}

	if err := w.addTree(root); err != nil {
		_ = nfy.Close()
		return nil, fmt.Errorf("watching %s: %w", root, err)
	}

	go w.run()
	go w.flushLoop(interval)

	return w, nil
}

// stop ends the watcher's goroutines and releases its OS watches.
func (w *fsWatcher) stop() {
	close(w.done)
	_ = w.nfy.Close()
}

// addTree adds a watch for every directory under root, skipping .git's
// contents except .git itself and .git/refs (recursively).
func (w *fsWatcher) addTree(root string) error {
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// A directory that vanished between the walk reaching its parent
			// and reaching it — a concurrent delete — is not fatal to
			// watching the rest of the tree.
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !d.IsDir() {
			return nil
		}
		if p != root && d.Name() == gitDir {
			w.addWatch(p)
			if err := w.addRefs(p); err != nil {
				return err
			}
			return filepath.SkipDir
		}
		w.addWatch(p)
		return nil
	})
	if err != nil {
		return fmt.Errorf("walking %s: %w", root, err)
	}
	return nil
}

// addRefs adds a recursive watch under gitPath/refs, tolerating a repository
// with no refs yet (a fresh `git init`, before the first commit).
func (w *fsWatcher) addRefs(gitPath string) error {
	err := w.addTree(filepath.Join(gitPath, "refs"))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// addWatch adds one directory to the underlying fsnotify watcher, best
// effort: a directory the OS refuses (permissions) or that disappeared
// before the Add reached it does not take the rest of the tree's watch down
// with it.
func (w *fsWatcher) addWatch(dir string) {
	if err := w.nfy.Add(dir); err != nil {
		return
	}
	w.mu.Lock()
	w.watched[dir] = true
	w.mu.Unlock()
}

// run carries fsnotify events to handle until the watcher is closed, which
// closes both of its channels.
func (w *fsWatcher) run() {
	for {
		select {
		case ev, ok := <-w.nfy.Events:
			if !ok {
				return
			}
			w.handle(ev)
		case _, ok := <-w.nfy.Errors:
			if !ok {
				return
			}
			// fsnotify surfaces OS-level watch failures here (a watch
			// dropped out from under it, a kernel event queue overflow).
			// None of them are actionable per-error, and the periodic flush
			// is what keeps the tree eventually consistent regardless of
			// whether every individual notification arrived.
		}
	}
}

// handle updates watch bookkeeping for one fsnotify event and marks its
// directory pending.
func (w *fsWatcher) handle(ev fsnotify.Event) {
	if ev.Has(fsnotify.Create) {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			// A directory was created, or moved in from elsewhere with
			// content already in it (a `git checkout` materializing a
			// subtree is exactly this) — either way it needs its own watch,
			// and everything under it needs one too.
			_ = w.addTree(ev.Name)
		}
	}
	if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
		w.mu.Lock()
		delete(w.watched, ev.Name)
		w.mu.Unlock()
	}

	rel, err := relFromOS(w.root, ev.Name)
	if err != nil {
		return
	}
	w.markPending(dirOf(rel))
}

// markPending records dir as changed since the last flush.
func (w *fsWatcher) markPending(dir string) {
	w.mu.Lock()
	w.pending[dir] = true
	w.mu.Unlock()
}

// flushLoop publishes the pending set to Events on a fixed cadence until the
// watcher stops.
func (w *fsWatcher) flushLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			w.flush()
		case <-w.done:
			return
		}
	}
}

// flush publishes and clears the pending set. A tick with nothing pending
// publishes nothing — the coalescer's whole point is that a quiet repository
// produces no traffic.
func (w *fsWatcher) flush() {
	w.mu.Lock()
	if len(w.pending) == 0 {
		w.mu.Unlock()
		return
	}
	dirs := make([]string, 0, len(w.pending))
	for d := range w.pending {
		dirs = append(dirs, d)
	}
	w.pending = make(map[string]bool)
	w.mu.Unlock()

	w.events.PublishTreeChanged(w.root, dirs)
}
