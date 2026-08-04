package watch

import (
	"fmt"
	"slices"
	"time"
)

// pollInterval is how often the polling fallback re-walks a project's
// worktree.
const pollInterval = time.Second

// pollWatcher watches one project's worktree by periodically re-walking it
// and diffing directory listings against the previous walk — the fallback
// for filesystems where fsnotify does not reliably see changes (network
// mounts, DESIGN.md §3.2).
//
// It walks exactly the tree List exposes, so — unlike fsWatcher — it does
// not also watch .git's HEAD and refs: that plumbing is groundwork for #8,
// and by the time #8 needs it on a polled project, it can poll those paths
// itself. Keeping this watcher scoped to what the tree UI actually shows is
// what keeps a periodic full re-walk affordable.
type pollWatcher struct {
	root   string
	events Events
	done   chan struct{}
}

// startPollWatcher begins polling root at the default interval.
func startPollWatcher(root string, events Events) (*pollWatcher, error) {
	return startPollWatcherWithInterval(root, events, pollInterval)
}

// startPollWatcherWithInterval is startPollWatcher with the poll cadence
// exposed, so a test can observe a diff without waiting out the real
// interval.
func startPollWatcherWithInterval(root string, events Events, interval time.Duration) (*pollWatcher, error) {
	snapshot, err := walkSnapshot(root)
	if err != nil {
		return nil, fmt.Errorf("polling %s: %w", root, err)
	}

	w := &pollWatcher{root: root, events: events, done: make(chan struct{})}
	go w.run(interval, snapshot)
	return w, nil
}

// stop ends the watcher's polling goroutine.
func (w *pollWatcher) stop() {
	close(w.done)
}

// run re-walks root on every tick, publishing whichever directories differ
// from the previous walk. A walk that errors — the worktree mid-churn, a
// branch switch removing directories out from under it — is skipped rather
// than treated as a change; the next tick tries again against the same
// baseline.
func (w *pollWatcher) run(interval time.Duration, previous map[string][]string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			current, err := walkSnapshot(w.root)
			if err != nil {
				continue
			}
			if changed := diffSnapshots(previous, current); len(changed) > 0 {
				w.events.PublishTreeChanged(w.root, changed)
			}
			previous = current
		case <-w.done:
			return
		}
	}
}

// walkSnapshot recursively lists every directory under root into one flat
// map from relative directory path ("." for root itself) to its sorted
// child names.
func walkSnapshot(root string) (map[string][]string, error) {
	snapshot := make(map[string][]string)
	if err := walkInto(root, ".", snapshot); err != nil {
		return nil, err
	}
	return snapshot, nil
}

// walkInto lists relDir and records it in snapshot, then recurses into every
// subdirectory it finds.
func walkInto(root, relDir string, snapshot map[string][]string) error {
	entries, err := List(root, relDir)
	if err != nil {
		return err
	}

	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name
	}
	snapshot[relDir] = names

	for _, e := range entries {
		if !e.IsDir {
			continue
		}
		if err := walkInto(root, joinRel(relDir, e.Name), snapshot); err != nil {
			return err
		}
	}
	return nil
}

// joinRel appends name onto a relative directory path in the slash-separated
// form this package uses throughout, treating "." (root) as the empty
// prefix.
func joinRel(dir, name string) string {
	if dir == "." || dir == "" {
		return name
	}
	return dir + "/" + name
}

// diffSnapshots returns the relative directory paths whose child list
// differs between two walks — added, removed, or renamed in place. A
// directory that vanished entirely between walks is reported too (its
// snapshot entry goes from a list to absent, which does not compare equal to
// anything): re-listing a directory that is now gone is how a caller
// currently showing it finds out, the same as any other change here.
func diffSnapshots(previous, current map[string][]string) []string {
	seen := make(map[string]bool, len(previous)+len(current))
	var changed []string
	check := func(dir string) {
		if seen[dir] {
			return
		}
		seen[dir] = true
		// Presence is compared separately from content: an empty directory
		// that was just created has the same (zero-length) name list as a
		// directory that was never there at all, and only the map's own
		// presence tells the two apart.
		prevNames, existedBefore := previous[dir]
		curNames, existsNow := current[dir]
		if existedBefore != existsNow || !equalNames(prevNames, curNames) {
			changed = append(changed, dir)
		}
	}
	for dir := range previous {
		check(dir)
	}
	for dir := range current {
		check(dir)
	}
	return changed
}

// equalNames reports whether two child-name lists are identical. Both sides
// come from List, which sorts deterministically, so a straight compare is
// enough — no need to sort again here.
func equalNames(a, b []string) bool {
	return slices.Equal(a, b)
}
