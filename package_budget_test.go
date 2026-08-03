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
		loc: 200, exported: 2,
		why: "Wails binding layer: the bound object plus the window options",
	},
	"internal/buildinfo": {
		loc: 150, exported: 2,
		why: "link-time build identity; a dependency root importing nothing first-party",
	},
}

// locCeilingNote explains why the LOC ceilings carry headroom while every other
// figure here is pinned to the actual.
//
// A LOC ceiling set to a package's exact current line count is not a ratchet,
// it is a freeze: one more line of doc comment in buildinfo.go would fail the
// build. The number has to represent the size at which a package stops being
// readable in one sitting, and m6t cannot measure that yet — the backend
// services that will be the real packages (git, pty, kube, helm; DESIGN.md
// §3.2) land in #2 and #5. So these figures are seeded as policy:
//
//   - 200 for internal/app and 150 for buildinfo — roughly 3x and 2x today's
//     size, so ordinary work does not trip the gate while a package that
//     doubles again arrives in review as a decomposition question.
//   - 60 for the root: main.go does one thing and must keep doing only that.
//
// Re-pin against real measurements once #2 and #5 land. No other ceiling here
// needs the caveat: counts of packages, files and exported names do not grow
// through ordinary editing.
const locCeilingNote = "LOC ceilings are policy-seeded; re-pin after #2/#5 (see locCeilingNote)"

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
// build constraint or licence header.
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
