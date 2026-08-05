package main_test

import (
	"fmt"
	"sort"
	"strings"
	"testing"
)

// TestNoDeadPackages fails when a first-party package is not reachable from
// main through non-test imports.
//
// This is the no-vaporware rule made mechanical (CLAUDE.md). Code that compiles
// but is not wired into the app still has to be read, reviewed, updated and
// kept building — it costs everything real code costs and returns nothing. The
// usual way it appears is a package written ahead of the feature that was going
// to use it.
//
// Reachability is computed over non-test imports only, deliberately: a package
// imported solely by its own tests is exactly the case this gate exists to
// catch, and counting test imports would hide it.
func TestNoDeadPackages(t *testing.T) {
	graph := firstPartyImports(t)
	reached := reachableFromMain(t, graph)

	var dead []string
	for dir := range graph {
		if !reached[dir] {
			dead = append(dead, dir)
		}
	}
	sort.Strings(dead)

	if len(dead) > 0 {
		t.Errorf("these packages are not reachable from main through non-test imports:\n  %s\n"+
			"Wire each one into the app in this PR or delete it. A package that only its own "+
			"tests import is not shipped code.", strings.Join(dead, "\n  "))
	}
}

// TestImportGraphIsPinned pins the first-party dependency edges.
//
// The package list is pinned by structuralPins; this pins what depends on what.
// It is the ratchet that keeps the layering in DESIGN.md §3.2 from eroding one
// convenient import at a time — depguard enforces the same shape at lint time,
// and this is the version that survives a config edit.
//
// Adding an edge means updating this table in the same PR, which is where the
// reviewer gets to ask whether the new dependency belongs.
func TestImportGraphIsPinned(t *testing.T) {
	// The composition root imports the binding layer; the binding layer reads
	// build identity and composes the backend services. buildinfo imports
	// nothing first-party — it is a leaf, and depguard pins that
	// independently.
	//
	// internal/app -> internal/pty is the first service edge (#2). It belongs
	// because the binding layer is where services are composed: the App owns
	// the Manager so that quitting the app can end the PTY sessions, which
	// nothing else is positioned to do. The edge runs one way only — pty
	// imports no first-party package at all, which is what keeps it usable
	// from the stream server (#3) without dragging the Wails layer in.
	//
	// internal/app -> internal/stream is #3's edge, and the shape of the two
	// together is the point. The stream server carries PTY bytes, but there is
	// no stream -> pty edge: stream declares a Terminals seam, pty knows nothing
	// about transports, and internal/app holds the adapter that joins them. That
	// is why this table has two service edges out of the binding layer and none
	// between the services — either service can be replaced without the other
	// being touched, and a future stream -> pty import would fail here as well
	// as at lint time.
	//
	// internal/app -> internal/project is #5's edge, and it is the same shape a
	// third time: the registry imports nothing first-party, knows nothing about
	// Wails or transports, and is composed here. The clone progress it produces
	// reaches the frontend because the binding layer hands each line to the
	// stream server — there is no project -> stream edge, for the same reason
	// there is no stream -> pty one. Three services out of the binding layer,
	// still none between them.
	//
	// internal/app -> internal/watch is #6's edge, the fourth service and the
	// same shape again: watch declares its own Events seam (mirroring stream's
	// Terminals) rather than importing internal/stream, so the binding layer
	// holds the one adapter (treeBridge, tree.go) that joins the two. There is
	// still no edge between any pair of services — watch does not import
	// project, project does not import watch — each one is composed, never
	// composing another.
	//
	// internal/app -> internal/git is #8's edge, and it is the shape with the
	// least in it: git declares no seam at all, because it pushes nothing. It
	// is a reader — the binding layer calls it and returns the answer — and
	// the notification that the answer is stale rides the watcher's existing
	// batch through the one adapter (watchBridge, tree.go). That is why there
	// is no git -> watch edge for the trigger and no stream -> git edge for
	// the payload: the event on the wire names a project, and the status
	// itself never leaves this package's reach.
	want := map[string][]string{
		rootPackageDir:       {"internal/app"},
		"internal/app":       {"internal/buildinfo", "internal/git", "internal/project", "internal/pty", "internal/stream", "internal/watch"},
		"internal/buildinfo": {},
		"internal/git":       {},
		"internal/project":   {},
		"internal/pty":       {},
		"internal/stream":    {},
		"internal/watch":     {},
	}

	graph := firstPartyImports(t)

	var problems []string
	for dir, deps := range graph {
		got := sortedKeys(deps)
		expected, pinned := want[dir]
		if !pinned {
			problems = append(problems, fmt.Sprintf(
				"%s has no entry in the pinned import graph; add one in this PR", dir))
			continue
		}
		sort.Strings(expected)
		if strings.Join(got, ",") != strings.Join(expected, ",") {
			problems = append(problems, fmt.Sprintf(
				"%s imports [%s], pinned as [%s] — update the pin in this PR and say why the dependency belongs",
				dir, strings.Join(got, " "), strings.Join(expected, " ")))
		}
	}
	for dir := range want {
		if _, ok := graph[dir]; !ok {
			problems = append(problems, fmt.Sprintf(
				"the import graph pins %s, which no longer exists; remove the stale entry", dir))
		}
	}
	sort.Strings(problems)

	if len(problems) > 0 {
		t.Errorf("import graph drifted from its pin:\n  %s", strings.Join(problems, "\n  "))
	}
}

// TestReachabilityFollowsTransitiveImports pins the reachability walk. A BFS
// that only looked one level deep would call a transitively-used package dead,
// and a walk that marked everything reached would never call anything dead —
// both failures look like a passing gate.
func TestReachabilityFollowsTransitiveImports(t *testing.T) {
	graph := map[string]map[string]bool{
		rootPackageDir:      {"internal/a": true},
		"internal/a":        {"internal/b": true},
		"internal/b":        {},
		"internal/orphan":   {},
		"internal/testonly": {},
	}

	reached := reachableFromMain(t, graph)

	for _, dir := range []string{rootPackageDir, "internal/a", "internal/b"} {
		if !reached[dir] {
			t.Errorf("%s should be reachable from main", dir)
		}
	}
	for _, dir := range []string{"internal/orphan", "internal/testonly"} {
		if reached[dir] {
			t.Errorf("%s is imported by nothing and must not be reported as reachable", dir)
		}
	}
}

// sortedKeys returns a set's members in sorted order.
func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
