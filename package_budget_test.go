package main_test

import (
	"bufio"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
)

// packagePin is one package's ratchet entry. Every first-party package has
// exactly one, and the table below IS the import ratchet: adding a package
// means adding an entry in the same PR, which makes package sprawl a
// deliberate act instead of a side effect.
type packagePin struct {
	// loc caps hand-written, non-test lines in the package.
	loc int
	// exported caps package-scope exported identifiers. Pinned to the actual
	// with zero slack: widening a seam should be visible in review, and the
	// diff that widens it is where the justification belongs.
	exported int
	// why records what the package is for, so a reviewer reading a ratchet
	// bump can judge whether the growth belongs there.
	why string
}

// structuralPins is the ratchet table, pinned to today's measurements.
//
// Reproduce every number with:
//
//	go test -count=1 -run 'TestPackageSizeBudget|TestPackageExportedSurfaceBudget' -v .
//
// Exported-surface counts are pinned at actuals with zero slack. The LOC
// ceilings are the one exception and carry headroom — see locCeilingNote,
// because that difference is a judgement call a reviewer should be able to
// challenge rather than discover.
var structuralPins = map[string]packagePin{
	rootPackageDir: {
		loc: 60, exported: 0,
		why: "composition root: embeds the frontend, hands options to the Wails runtime",
	},
	"internal/app": {
		loc: 400, exported: 2,
		why: "Wails binding layer: the bound object, the window options, and the adapters that join sibling services",
	},
	"internal/buildinfo": {
		loc: 150, exported: 2,
		why: "link-time build identity; a dependency root importing nothing first-party",
	},
	"internal/project": {
		loc: 650, exported: 9,
		why: "project registry: the persistent list of manifest repositories and their per-project settings",
	},
	"internal/pty": {
		loc: 750, exported: 7,
		why: "PTY service: session lifecycle, scrollback and platform termination for the embedded terminal",
	},
	"internal/stream": {
		loc: 900, exported: 5,
		why: "loopback stream server: token-authenticated WebSocket transport for PTY I/O and backend-push events",
	},
}

// locCeilingNote explains why the LOC ceilings carry headroom while every other
// figure here is pinned to the actual.
//
// A LOC ceiling set to a package's exact current line count is not a ratchet,
// it is a freeze: one more line of doc comment in buildinfo.go would fail the
// build. The number has to represent the size at which a package stops being
// readable in one sitting.
//
// internal/pty and internal/stream are measured rather than policy-seeded.
//
//   - internal/pty landed with #2 at 644 lines across six files, and 750 is that
//     plus room for the follow-up fixes a new service attracts — not enough room
//     for a second service to move in alongside it. #3 added the detach seam and
//     took it to 705, inside the ceiling set for exactly that kind of follow-up.
//   - internal/stream landed with #3 at 838 lines across six files: a wire
//     protocol server — auth, framing, backpressure, two endpoints — with the
//     protocol itself specified in PROTOCOL.md rather than inferred from the
//     handlers. 900 is that plus the same kind of headroom, and the services
//     that will push events onto its /events channel (#5) plug into the existing
//     envelope rather than adding endpoints, so this number should hold.
//
// internal/app's ceiling moved from 200 to 260 in #3. The reason is a shape
// this repo will see again: sibling services must not import each other, so the
// binding layer is where a service is adapted onto another's declared seam, and
// #3 put the first such adapter (pty.Manager -> stream.Terminals) in
// terminals.go. The ceiling is today's 201 plus room for one more adapter of the
// same size. What it still refuses is behavior: an adapter that grows past
// translation, or a service implemented here instead of composed here, is what
// this number exists to bring to review.
//
// 260 -> 400 in #5, and this is the raise most worth arguing with. The registry
// bindings in projects.go are 82 lines for five methods, four of them a
// delegation to internal/project with an error wrap and the fifth a native
// dialog — the shape this ceiling wants, not the shape it refuses. What actually
// moved the number is that the binding layer now composes three services instead
// of two, and each arrives with a doc comment explaining why its operation
// belongs on the bridge rather than behind the transport. 400 is today's 343
// plus room for one more service of that size. The check on this is not the line count but the god-object
// gate: if these lines were behavior rather than delegation, App would be
// growing fields, and maxAppFields is still pinned at one handle per service.
//
// internal/project is measured: it landed with #5 at 570 lines across three
// files — the registry and its read-modify-write cycles, the confined atomic
// store, and the project schema — and 650 is that plus the follow-up room a new
// service attracts, the same allowance internal/pty got in #2.
//
// The rest are still seeded as policy, because the services that would let
// them be measured (git, kube, helm; DESIGN.md §3.2) land later:
//
//   - 150 for buildinfo — roughly 2x today's size, so ordinary work does not
//     trip the gate while a package that doubles again arrives in review as a
//     decomposition question.
//   - 60 for the root: main.go does one thing and must keep doing only that.
//
// Both are still policy-seeded after #5 rather than re-pinned: neither package
// changed, so there is no new measurement to pin them to. No other ceiling here
// needs the caveat: counts of packages, files and exported names do not grow
// through ordinary editing.
const locCeilingNote = "internal/pty, internal/stream, internal/app and internal/project are measured; buildinfo and the root are policy-seeded (see locCeilingNote)"

// maxFilesPerPackage stops a package from escaping its LOC budget by fanning
// the same code across many small files.
const maxFilesPerPackage = 8

// generatedMarkerRe matches the canonical generated-code marker
// (https://go.dev/s/generatedcode). A file carrying it is excluded from the
// size budget: generated code is not a package's maintenance burden.
var generatedMarkerRe = regexp.MustCompile(`^// Code generated .* DO NOT EDIT\.?$`)

// packageSize is one package's measured footprint.
type packageSize struct {
	loc   int
	files int
}

// measurePackages returns the non-generated, non-test footprint of every
// first-party package, keyed by repo-relative directory.
func measurePackages(t *testing.T) map[string]packageSize {
	t.Helper()
	sizes := map[string]packageSize{}
	walkGoSource(t, func(file, dir string) {
		generated, loc := countGoFile(t, repoFS, file)
		if generated {
			return
		}
		size := sizes[dir]
		size.loc += loc
		size.files++
		sizes[dir] = size
	})
	return sizes
}

// countGoFile reports whether the named file is generated and, if not, how
// many lines it holds. The marker conventionally precedes the package clause,
// but scanning the whole file is cheap and does not miss one placed after a
// build constraint or license header.
func countGoFile(t *testing.T, fsys fs.FS, file string) (generated bool, loc int) {
	t.Helper()
	f, err := fsys.Open(file)
	if err != nil {
		t.Fatalf("opening %s: %v", file, err)
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			t.Errorf("closing %s: %v", file, closeErr)
		}
	}()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if generatedMarkerRe.MatchString(strings.TrimSpace(scanner.Text())) {
			generated = true
		}
		loc++
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanning %s: %v", file, err)
	}
	return generated, loc
}

// TestPackageSizeBudget fails when a package outgrows its ceiling. Hitting it
// is the signal to decompose the package into cohesive pieces — not to raise
// the number, which defeats the gate.
func TestPackageSizeBudget(t *testing.T) {
	sizes := measurePackages(t)

	var violations []string
	for dir, size := range sizes {
		pin, pinned := structuralPins[dir]
		if !pinned {
			// TestEveryPackageIsPinned reports unpinned packages with the full
			// explanation; skipping here keeps one new package to one failure.
			continue
		}
		t.Logf("%-20s %4d LOC (ceiling %d), %d files (ceiling %d)",
			dir, size.loc, pin.loc, size.files, maxFilesPerPackage)
		if size.loc > pin.loc {
			violations = append(violations, fmt.Sprintf(
				"%s: %d LOC exceeds its ceiling of %d — decompose the package, do not raise the ceiling (%s)",
				dir, size.loc, pin.loc, locCeilingNote))
		}
		if size.files > maxFilesPerPackage {
			violations = append(violations, fmt.Sprintf(
				"%s: %d files exceeds the ceiling of %d — split the package, do not raise the ceiling",
				dir, size.files, maxFilesPerPackage))
		}
	}
	sort.Strings(violations)

	if len(violations) > 0 {
		t.Errorf("package size budget exceeded:\n  %s", strings.Join(violations, "\n  "))
	}
}

// TestEveryPackageIsPinned is the other half of the size budget: a package with
// no pin is measured against nothing, so it fails here rather than silently
// escaping every ceiling.
func TestEveryPackageIsPinned(t *testing.T) {
	for _, dir := range packageDirs(t) {
		if _, ok := structuralPins[dir]; !ok {
			t.Errorf("package %s has no entry in structuralPins; add one (loc, exported, why) in this PR", dir)
		}
	}
	for dir := range structuralPins {
		if _, err := fs.Stat(repoFS, dir); err != nil {
			t.Errorf("structuralPins pins %s, which no longer exists; remove the stale entry", dir)
		}
	}
}

// TestCountGoFileDetectsGeneratedCode exercises marker detection and line
// counting directly: it is the unit that proves generated code is excluded
// from the budget rather than quietly inflating it.
func TestCountGoFileDetectsGeneratedCode(t *testing.T) {
	tests := []struct {
		name          string
		content       string
		wantGenerated bool
		wantLOC       int
	}{
		{
			name:          "hand-written file is counted",
			content:       "package x\n\nfunc f() {}\n",
			wantGenerated: false,
			wantLOC:       3,
		},
		{
			name:          "canonical generated marker is detected",
			content:       "// Code generated by stringer. DO NOT EDIT.\npackage x\n",
			wantGenerated: true,
			wantLOC:       2,
		},
		{
			name:          "marker after a build constraint is still detected",
			content:       "//go:build ignore\n\n// Code generated by mockgen. DO NOT EDIT.\npackage m\n",
			wantGenerated: true,
			wantLOC:       4,
		},
		{
			name:          "prose that merely mentions generated code is not a marker",
			content:       "package x\n\n// this is not Code generated by anything, DO NOT EDIT it\n",
			wantGenerated: false,
			wantLOC:       3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fsys := fstest.MapFS{"f.go": &fstest.MapFile{Data: []byte(tt.content)}}
			generated, loc := countGoFile(t, fsys, "f.go")
			if generated != tt.wantGenerated {
				t.Errorf("generated = %v, want %v", generated, tt.wantGenerated)
			}
			if loc != tt.wantLOC {
				t.Errorf("loc = %d, want %d", loc, tt.wantLOC)
			}
		})
	}
}
