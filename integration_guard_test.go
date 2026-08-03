package main_test

import (
	"go/build/constraint"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The integration guard closes the "test that never runs" gap.
//
// A build-tagged test is invisible to `go test ./...`: it compiles, it looks
// like coverage, and it executes nowhere. A tag typo has the same effect as
// deleting the suite, silently. m6t has no integration suite yet — the ones
// that will need one (git against real repositories, PTY against a real shell,
// kubectl against a cluster) arrive with #2 and #5 — so this gate is quiet
// today and fires the moment a tagged file lands without the wiring to run it.
//
// Run: go test -run TestIntegrationTestsAreExecuted .

// integrationTag is the build tag reserved for tests that need real external
// systems.
const integrationTag = "integration"

// TestIntegrationTestsAreExecuted fails when an integration-tagged test exists
// with no make target that runs it, and when a target exists that `make verify`
// never calls.
func TestIntegrationTestsAreExecuted(t *testing.T) {
	tagged := taggedTestFiles(t)
	makefile := readRepoFile(t, "Makefile")
	runner := integrationRunnerTarget(makefile)

	if len(tagged) == 0 {
		if runner != "" {
			t.Errorf("the Makefile has target %q running -tags=%s, but no integration-tagged test files exist; "+
				"remove the target or add the suite it was written for", runner, integrationTag)
		}
		t.Logf("no %s-tagged test files in the tree; the guard is armed for when one lands", integrationTag)
		return
	}

	if runner == "" {
		sort.Strings(tagged)
		t.Fatalf("these test files require the %q build tag but no Makefile target runs them, "+
			"so they execute nowhere and rot silently:\n  %s\n"+
			"Add a target that runs `go test -tags=%s ./...` and make `verify` depend on it, "+
			"or drop the tag so the plain test run picks them up.",
			integrationTag, strings.Join(tagged, "\n  "), integrationTag)
	}

	if !verifyRunsTarget(t, makefile, runner) {
		t.Errorf("target %q runs the %s suite but `make verify` does not depend on it, "+
			"so the suite still never runs in the gate; add it to verify's prerequisites",
			runner, integrationTag)
	}
}

// taggedTestFiles returns the repo-relative paths of test files whose build
// constraints require the integration tag.
func taggedTestFiles(t *testing.T) []string {
	t.Helper()
	var tagged []string
	err := fs.WalkDir(repoFS, rootPackageDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != rootPackageDir && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		content, readErr := fs.ReadFile(repoFS, p)
		if readErr != nil {
			return readErr
		}
		if requiresIntegrationTag(string(content)) {
			tagged = append(tagged, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking for integration-tagged tests: %v", err)
	}
	return tagged
}

// requiresIntegrationTag reports whether the source's build constraints make it
// build with the integration tag set and not without it. Constraints precede
// the package clause, so the scan stops there.
func requiresIntegrationTag(src string) bool {
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "package ") {
			return false
		}
		if !constraint.IsGoBuild(trimmed) {
			continue
		}
		expr, err := constraint.Parse(trimmed)
		if err != nil {
			return false
		}
		// Vary ONLY the integration tag and treat every other constraint as
		// satisfiable. A file tagged `integration && linux` still requires the
		// integration tag; whether the host is Linux is a separate question,
		// and evaluating GOOS against the machine running the gate would make
		// the answer depend on who ran it.
		eval := func(withIntegration bool) bool {
			return expr.Eval(func(tag string) bool {
				if tag == integrationTag {
					return withIntegration
				}
				return true
			})
		}
		return eval(true) && !eval(false)
	}
	return false
}

// integrationRunnerRe finds a Makefile target whose recipe runs go test with
// the integration tag, capturing the target name.
var integrationRunnerRe = regexp.MustCompile(`(?ms)^([a-zA-Z0-9_-]+):[^\n]*\n(?:\t[^\n]*\n)*?\t[^\n]*-tags[= ]` + integrationTag)

// integrationRunnerTarget returns the name of the Makefile target that runs the
// integration suite, or "" when no target does.
func integrationRunnerTarget(makefile string) string {
	m := integrationRunnerRe.FindStringSubmatch(makefile)
	if m == nil {
		return ""
	}
	return m[1]
}

// verifyRunsTarget reports whether the named target is one of verify's
// prerequisites.
func verifyRunsTarget(t *testing.T, makefile, target string) bool {
	t.Helper()
	deps := firstSubmatch(t, makefile,
		`(?m)^verify:((?:[^\n]*\\\n)*[^\n]*)`, "the verify target's prerequisites")
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(target) + `\b`).MatchString(deps)
}

// TestIntegrationTagDetection pins the constraint reader. A reader that missed
// the tag would make the guard permanently silent; one that saw it everywhere
// would fail every ordinary test file. Both look like a working gate.
func TestIntegrationTagDetection(t *testing.T) {
	tests := []struct {
		name string
		src  string
		want bool
	}{
		{
			name: "plain test file is not tagged",
			src:  "package x\n\nimport \"testing\"\n",
			want: false,
		},
		{
			name: "integration constraint is detected",
			src:  "//go:build integration\n\npackage x\n",
			want: true,
		},
		{
			name: "integration in a conjunction is detected",
			src:  "//go:build integration && linux\n\npackage x\n",
			want: true,
		},
		{
			name: "a disjunction that also builds untagged is not integration-only",
			src:  "//go:build integration || !integration\n\npackage x\n",
			want: false,
		},
		{
			name: "an unrelated tag is not the integration tag",
			src:  "//go:build e2e\n\npackage x\n",
			want: false,
		},
		{
			name: "a constraint-looking line after the package clause is ignored",
			src:  "package x\n\n//go:build integration\n",
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := requiresIntegrationTag(tt.src); got != tt.want {
				t.Errorf("requiresIntegrationTag = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestIntegrationRunnerDetection pins the Makefile reader against the shapes a
// real target takes.
func TestIntegrationRunnerDetection(t *testing.T) {
	tests := []struct {
		name     string
		makefile string
		want     string
	}{
		{
			name:     "no target runs the tag",
			makefile: "test:\n\tgo test ./...\n",
			want:     "",
		},
		{
			name:     "target running the tag is found",
			makefile: "test-integration:\n\t@echo running\n\tgo test -tags=integration ./...\n",
			want:     "test-integration",
		},
		{
			name:     "space-separated tags flag is found",
			makefile: "itest:\n\tgo test -tags integration ./...\n",
			want:     "itest",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := integrationRunnerTarget(tt.makefile); got != tt.want {
				t.Errorf("integrationRunnerTarget = %q, want %q", got, tt.want)
			}
		})
	}
}
