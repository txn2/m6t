package main_test

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The guard on the guards.
//
// Every gate in this directory is a plain Go test, which is what makes it cheap
// and what makes it fragile in one specific way: a test that stops running
// fails nothing. Move a gate into a package the root test run does not reach,
// give it a build tag, or rename it out of the Test prefix, and the ratchet
// silently stops ratcheting while `make verify` stays green.
//
// This file pins the wiring: the gate files exist, they are in the root test
// package that `go test ./...` runs, they carry no build tag, and `make verify`
// runs the test target that executes them.
//
// Run: go test -run TestStructuralGatesAreWired .

// structuralGateFiles lists the gate files and the gate each one provides.
// Adding a gate means adding it here, which is what keeps this guard honest as
// the set grows.
var structuralGateFiles = map[string]string{
	"package_budget_test.go":    "package size budget and the pinned package list",
	"surface_budget_test.go":    "exported-surface budget",
	"godobject_budget_test.go":  "coordinator field/method ceilings",
	"package_graph_test.go":     "dead-package detection and the pinned import graph",
	"noop_interface_test.go":    "no-op-only interface detection",
	"integration_guard_test.go": "integration-tagged tests actually execute",
	"frontend_ratchet_test.go":  "ESLint suppressions only shrink",
	"pins_test.go":              "gate figures agree across Makefile, CI, codecov and docs",
	// This file guards the others, so it guards itself too: excluded from the
	// test run it would take every gate above with it and report nothing.
	"structural_gates_test.go": "the gates above are wired into the test run",
}

// rootTestPackage is the package every root gate file must declare so that the
// module's own test run executes it.
const rootTestPackage = "package main_test"

// TestStructuralGatesAreWired fails when a gate file is missing, lives outside
// the root test package, or carries a build constraint that would keep it out
// of the default test run.
func TestStructuralGatesAreWired(t *testing.T) {
	var problems []string

	for file, gate := range structuralGateFiles {
		content, err := fs.ReadFile(repoFS, file)
		if err != nil {
			problems = append(problems, fmt.Sprintf(
				"%s is missing — it provides the %s gate; restore it or remove it from structuralGateFiles with the reason", file, gate))
			continue
		}
		src := string(content)
		if !strings.Contains(src, rootTestPackage) {
			problems = append(problems, fmt.Sprintf(
				"%s does not declare %q, so the root test run does not execute the %s gate", file, rootTestPackage, gate))
		}
		if requiresIntegrationTag(src) || hasBuildConstraint(src) {
			problems = append(problems, fmt.Sprintf(
				"%s carries a build constraint, so the %s gate is excluded from the default test run", file, gate))
		}
		if !hasTestFunc(src) {
			problems = append(problems, fmt.Sprintf(
				"%s declares no Test function, so the %s gate runs nothing", file, gate))
		}
	}
	sort.Strings(problems)

	if len(problems) > 0 {
		t.Errorf("structural gates are not wired into the test run:\n  %s", strings.Join(problems, "\n  "))
	}
}

// TestVerifyRunsTheStructuralGates pins the other half of the wiring: the gates
// run under `go test ./...`, and `make verify` has to actually run that.
//
// pins_test.go asserts verify's prerequisite list contains `test`; this asserts
// the test target runs the whole module rather than a subset that could quietly
// exclude the root package where every gate lives.
func TestVerifyRunsTheStructuralGates(t *testing.T) {
	makefile := readRepoFile(t, "Makefile")

	recipe := firstSubmatch(t, makefile,
		`(?m)^test:[^\n]*\n((?:\t[^\n]*\n)+)`, "the test target's recipe")

	if !strings.Contains(recipe, "./...") {
		t.Errorf("the `test` target does not run ./..., so the root package holding every structural gate may be skipped:\n%s", recipe)
	}
	if !strings.Contains(recipe, "-count=1") {
		t.Errorf("the `test` target does not pass -count=1, so a cached pass could stand in for a gate that was never re-run:\n%s", recipe)
	}
}

// gitDiffRe matches a recipe line that compares against git.
var gitDiffRe = regexp.MustCompile(`git\b[^\n]*\bdiff\b`)

// requireTrackedRe matches a call to the untracked-files guard.
var requireTrackedRe = regexp.MustCompile(`require-tracked\.sh`)

// makeTargetRe splits the Makefile into targets and their recipes.
var makeTargetRe = regexp.MustCompile(`(?m)^([a-zA-Z0-9_-]+):[^\n]*\n((?:(?:\t[^\n]*)?\n)*)`)

// TestGitDiffGatesRequireTrackedFiles fails when a gate compares against git
// without first refusing to run on untracked files.
//
// `git diff` cannot see untracked files, so a gate built on it skips every NEW
// file silently — and a silent skip is indistinguishable from a pass. This is
// not a theoretical failure mode: `make lint` had exactly this hole and
// reported green on ten unlinted files that CI then rejected (PR #21). The
// guard was added to one gate and not its neighbors, which is why the rule is
// mechanical now instead of remembered.
func TestGitDiffGatesRequireTrackedFiles(t *testing.T) {
	makefile := readRepoFile(t, "Makefile")

	var unguarded []string
	for _, m := range makeTargetRe.FindAllStringSubmatch(makefile, -1) {
		target, recipe := m[1], m[2]
		if !gitDiffRe.MatchString(recipe) {
			continue
		}
		if !requireTrackedRe.MatchString(recipe) {
			unguarded = append(unguarded, target)
		}
	}
	sort.Strings(unguarded)

	if len(unguarded) > 0 {
		t.Errorf("these targets compare against git without calling scripts/require-tracked.sh first, "+
			"so they would silently skip untracked files and report a pass:\n  %s",
			strings.Join(unguarded, "\n  "))
	}

	// The scripts do the same thing outside a Makefile recipe, so they are
	// checked directly rather than through the target scan above.
	for _, script := range []string{"scripts/patch-coverage.sh"} {
		src := readRepoFile(t, script)
		if gitDiffRe.MatchString(src) && !requireTrackedRe.MatchString(src) {
			t.Errorf("%s compares against git without calling require-tracked.sh", script)
		}
	}
}

// TestGitDiffGateDetectorFires pins the scan. A detector that matched nothing
// would let every gate through unguarded while looking green.
func TestGitDiffGateDetectorFires(t *testing.T) {
	guarded := "safe:\n\t@./scripts/require-tracked.sh safe '*.go'\n\tgit diff HEAD\n\n"
	unguarded := "unsafe:\n\tgit diff HEAD\n\n"
	unrelated := "plain:\n\tgo test ./...\n\n"

	scan := func(makefile string) []string {
		var found []string
		for _, m := range makeTargetRe.FindAllStringSubmatch(makefile, -1) {
			if gitDiffRe.MatchString(m[2]) && !requireTrackedRe.MatchString(m[2]) {
				found = append(found, m[1])
			}
		}
		return found
	}

	if got := scan(guarded); len(got) != 0 {
		t.Errorf("a guarded target was reported as unguarded: %v", got)
	}
	if got := scan(unguarded); len(got) != 1 || got[0] != "unsafe" {
		t.Errorf("an unguarded target was not reported: %v", got)
	}
	if got := scan(unrelated); len(got) != 0 {
		t.Errorf("a target that does not use git diff was reported: %v", got)
	}
}

// buildConstraintRe matches a //go:build line.
var buildConstraintRe = regexp.MustCompile(`(?m)^//go:build `)

// packageClauseRe matches the package clause that ends the constraint region.
var packageClauseRe = regexp.MustCompile(`(?m)^package `)

// hasBuildConstraint reports whether the source carries a build constraint.
//
// Only the region before the package clause counts: a constraint is only a
// constraint there, and scanning the whole file would misread the //go:build
// strings that this repository's own gate fixtures contain.
func hasBuildConstraint(src string) bool {
	head := src
	if loc := packageClauseRe.FindStringIndex(src); loc != nil {
		head = src[:loc[0]]
	}
	return buildConstraintRe.MatchString(head)
}

// testFuncRe matches a top-level Go test function declaration.
var testFuncRe = regexp.MustCompile(`(?m)^func Test[A-Z_]\w*\(t \*testing\.T\)`)

// hasTestFunc reports whether the source declares at least one test function.
func hasTestFunc(src string) bool {
	return testFuncRe.MatchString(src)
}

// TestWiringDetectorsFire pins the two detectors this guard depends on. A
// constraint detector that never matched, or a test-function detector that
// always matched, would make the guard above report success unconditionally.
func TestWiringDetectorsFire(t *testing.T) {
	constrained := "//go:build integration\n\npackage main_test\n\nfunc TestX(t *testing.T) {}\n"
	plain := "package main_test\n\nfunc TestX(t *testing.T) {}\n"
	// A gate file that holds a constraint string as a fixture — which several
	// of the files in this directory do — must not read as constrained itself.
	fixtureHoldsAConstraint := "package main_test\n\nconst src = `\n" +
		"//go:build integration\n\npackage x\n`\n\nfunc TestX(t *testing.T) {}\n"
	noTests := "package main_test\n\nfunc helper() {}\n"

	if !hasBuildConstraint(constrained) {
		t.Error("hasBuildConstraint missed a real //go:build line")
	}
	if hasBuildConstraint(plain) {
		t.Error("hasBuildConstraint fired on a file with no constraint")
	}
	if hasBuildConstraint(fixtureHoldsAConstraint) {
		t.Error("hasBuildConstraint fired on a constraint that appears only in a fixture after the package clause")
	}
	if !hasTestFunc(plain) {
		t.Error("hasTestFunc missed a test function")
	}
	if hasTestFunc(noTests) {
		t.Error("hasTestFunc fired on a file with no test function")
	}
}
