// Pin-drift gates. A documentation claim about a build gate is a claim like
// any other: it gets verified mechanically, not by review. These tests fail
// when CONTRIBUTING.md names a tool version the Makefile does not pin, when CI
// pins a different version than the Makefile, or when a coverage floor is
// stated as two different numbers across the Makefile, codecov.yml, the CI
// workflow and CONTRIBUTING.md.
//
// The failure they exist to prevent: a gate figure that disagrees between
// local and CI turns `make verify` from a guarantee into a guess. A change can
// then land between the two floors — green locally, red in CI — which is the
// exact parity gap the leash is built to close.
package main_test

import (
	"io/fs"
	"os"
	"path"
	"regexp"
	"testing"
)

// makefileVar extracts a `NAME := value` assignment from the Makefile.
func makefileVar(t *testing.T, makefile, name string) string {
	t.Helper()
	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(name) + `\s*:=\s*(\S+)\s*$`)
	m := re.FindStringSubmatch(makefile)
	if m == nil {
		t.Fatalf("Makefile has no %s assignment", name)
	}
	return m[1]
}

// firstSubmatch returns the first capture of pattern in text, failing when the
// pattern no longer matches — a rewrite that drops the statement is itself
// drift, not a reason to skip the check.
func firstSubmatch(t *testing.T, text, pattern, what string) string {
	t.Helper()
	m := regexp.MustCompile(pattern).FindStringSubmatch(text)
	if m == nil {
		t.Fatalf("could not find %s (pattern %s)", what, pattern)
	}
	return m[1]
}

// allSubmatches returns every first-capture of pattern in text.
func allSubmatches(text, pattern string) []string {
	matches := regexp.MustCompile(pattern).FindAllStringSubmatch(text, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, m[1])
	}
	return out
}

// repoFS scopes every read below to the repository root. io/fs rejects
// absolute paths and any ".." element, so a mistyped argument fails loudly
// instead of reaching outside the repo — and its paths are always
// slash-separated, which keeps these tests working on the Windows runner.
var repoFS = os.DirFS(".")

func readRepoFile(t *testing.T, parts ...string) string {
	t.Helper()
	name := path.Join(parts...)
	data, err := fs.ReadFile(repoFS, name)
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	return string(data)
}

type agreement struct {
	what    string
	text    string
	pattern string
	want    string
}

// checkAll asserts every occurrence of each pattern equals the Makefile's
// value, and that each pattern matches at least once.
func checkAll(t *testing.T, cases []agreement) {
	t.Helper()
	for _, c := range cases {
		got := allSubmatches(c.text, c.pattern)
		if len(got) == 0 {
			t.Errorf("%s: no value found (pattern %s)", c.what, c.pattern)
			continue
		}
		for _, g := range got {
			if g != c.want {
				t.Errorf("%s says %s, the Makefile pins %s", c.what, g, c.want)
			}
		}
	}
}

// TestToolPinsAgree asserts every place naming a pinned tool version names the
// Makefile's version. Following CONTRIBUTING.md verbatim must produce a
// toolchain `make tools-check` accepts, and CI must run what the Makefile
// pins: two gosec versions enable two different rule sets, so a local run can
// pass while CI rejects the identical diff.
func TestToolPinsAgree(t *testing.T) {
	makefile := readRepoFile(t, "Makefile")
	contributing := readRepoFile(t, "CONTRIBUTING.md")
	ci := readRepoFile(t, ".github", "workflows", "ci.yml")

	golangciPin := makefileVar(t, makefile, "GOLANGCI_LINT_VERSION")
	gosecPin := makefileVar(t, makefile, "GOSEC_VERSION")
	gremlinsPin := makefileVar(t, makefile, "GREMLINS_VERSION")
	wailsPin := makefileVar(t, makefile, "WAILS_VERSION")

	const (
		golangciInstall = `golangci-lint/v2/cmd/golangci-lint@(v[0-9.]+)`
		gosecInstall    = `gosec/v2/cmd/gosec@(v[0-9.]+)`
		gremlinsInstall = `gremlins/cmd/gremlins@(v[0-9.]+)`
		wailsInstall    = `wails/v2/cmd/wails@(v[0-9.]+)`
	)

	checkAll(t, []agreement{
		{"CONTRIBUTING.md golangci-lint install", contributing, golangciInstall, golangciPin},
		{"CONTRIBUTING.md gosec install", contributing, gosecInstall, gosecPin},
		{"CONTRIBUTING.md gremlins install", contributing, gremlinsInstall, gremlinsPin},
		{"CONTRIBUTING.md wails install", contributing, wailsInstall, wailsPin},
		{"ci.yml gosec install", ci, gosecInstall, gosecPin},
		{"ci.yml wails install", ci, wailsInstall, wailsPin},
		{
			"ci.yml golangci-lint-action version", ci,
			`(?s)golangci-lint-action@.{0,300}?version:\s*(v[0-9.]+)`, golangciPin,
		},
	})
}

// TestGateFiguresAgree asserts each coverage floor is one number everywhere it
// is stated.
func TestGateFiguresAgree(t *testing.T) {
	makefile := readRepoFile(t, "Makefile")
	contributing := readRepoFile(t, "CONTRIBUTING.md")
	ci := readRepoFile(t, ".github", "workflows", "ci.yml")
	codecov := readRepoFile(t, "codecov.yml")

	total := makefileVar(t, makefile, "COVERAGE_MIN")
	patch := makefileVar(t, makefile, "PATCH_COVERAGE_MIN")
	efficacy := makefileVar(t, makefile, "MUTATION_EFFICACY_MIN")

	checkAll(t, []agreement{
		{"ci.yml coverage threshold", ci, `COVERAGE < ([0-9]+)`, total},
		{"codecov.yml project target", codecov, `(?s)project:.*?target:\s*([0-9]+)%`, total},
		{"codecov.yml patch target", codecov, `(?s)patch:.*?target:\s*([0-9]+)%`, patch},
		{
			"CONTRIBUTING.md total-coverage floor", contributing,
			`Total coverage must be at least \*\*([0-9]+)%\*\*`, total,
		},
		{
			"CONTRIBUTING.md patch-coverage floor", contributing,
			`lines your change touches must be at least \*\*([0-9]+)%\*\*`, patch,
		},
		{
			"CONTRIBUTING.md mutation-efficacy floor", contributing,
			`Mutation-testing efficacy ≥ \*\*([0-9]+)%\*\*`, efficacy,
		},
	})
}

// TestComplexityBudgetsAgreeAcrossLanguages asserts the per-function budgets
// are the same numbers on both sides of the bridge. CONTRIBUTING.md states one
// pair of figures for the whole project; two languages drifting apart would
// make that statement false for whichever side moved.
func TestComplexityBudgetsAgreeAcrossLanguages(t *testing.T) {
	golangci := readRepoFile(t, ".golangci.yml")
	eslint := readRepoFile(t, "frontend", "eslint.config.js")
	contributing := readRepoFile(t, "CONTRIBUTING.md")

	cyclomatic := firstSubmatch(t, golangci,
		`(?s)gocyclo:\s*\n\s*min-complexity:\s*([0-9]+)`, ".golangci.yml gocyclo budget")
	cognitive := firstSubmatch(t, golangci,
		`(?s)gocognit:\s*\n\s*min-complexity:\s*([0-9]+)`, ".golangci.yml gocognit budget")

	checkAll(t, []agreement{
		{
			"frontend eslint complexity rule", eslint,
			`complexity: \["error", ([0-9]+)\]`, cyclomatic,
		},
		{
			"frontend eslint cognitive-complexity rule", eslint,
			`"sonarjs/cognitive-complexity": \["error", ([0-9]+)\]`, cognitive,
		},
		{
			"CONTRIBUTING.md cyclomatic budget", contributing,
			`Cyclomatic complexity ≤ \*\*([0-9]+)\*\*`, cyclomatic,
		},
		{
			"CONTRIBUTING.md cognitive budget", contributing,
			`cognitive complexity ≤ \*\*([0-9]+)\*\*`, cognitive,
		},
	})
}

// TestVerifyRunsEveryGateCIRuns is the parity claim itself, checked as far as
// static inspection can: every Makefile target CI invokes by name must exist,
// and `verify` must depend on the local gates whose CI counterparts exist.
// It cannot prove the two run identical code — that is what keeping the figure
// checks above green is for — but it does catch a gate deleted from one side.
func TestVerifyRunsEveryGateCIRuns(t *testing.T) {
	makefile := readRepoFile(t, "Makefile")

	// The prerequisite list wraps across backslash-continued lines.
	verifyDeps := firstSubmatch(t, makefile,
		`(?m)^verify:((?:[^\n]*\\\n)*[^\n]*)`, "the verify target's prerequisites")

	// Each of these has a CI job doing the same work at the same threshold:
	// fmt/lint -> Lint, test/coverage-report -> Test, frontend-* -> Frontend,
	// build-check -> Build, security/semgrep -> Security Scan,
	// licenses -> Licenses.
	required := []string{
		"tools-check", "fmt", "test", "coverage-report", "patch-coverage",
		"lint", "security", "semgrep", "licenses", "frontend-lint",
		"frontend-test", "bindings-check", "build-check",
	}
	for _, target := range required {
		if !regexp.MustCompile(`\b` + regexp.QuoteMeta(target) + `\b`).MatchString(verifyDeps) {
			t.Errorf("`make verify` does not run %q; CI does", target)
		}
		if !regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(target) + `:`).MatchString(makefile) {
			t.Errorf("the Makefile has no %q target", target)
		}
	}

	// Mutation testing is expensive and belongs to verify-release. Letting it
	// back into verify makes the per-commit gate slow enough that people stop
	// running it, which costs more than the mutants it catches.
	if regexp.MustCompile(`\bmutate\b`).MatchString(verifyDeps) {
		t.Error("`make verify` runs `mutate`; mutation testing belongs in verify-release")
	}
}
