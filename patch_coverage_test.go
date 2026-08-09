// Gate-arithmetic parity. pins_test.go verifies that the Makefile, ci.yml,
// codecov.yml and CONTRIBUTING.md all state the same patch-coverage FIGURE.
// This file verifies the other half of that agreement: that the figure MEANS
// the same thing on both sides of the gate.
//
// The two enforce 85% by different arithmetic unless something holds them
// together. `go tool cover` reports blocks, and blocks overlap, so a line can
// sit inside one block that ran and another that did not. Codecov calls that a
// partial and counts it against you; the local gate used to count it as
// covered. On PR #28 the gap was 3.6 points in the direction that misleads —
// `make patch-coverage` 88.0% and green, codecov/patch 84.35% and red, on one
// diff (#29).
//
// Reproduce with:
//
//	go test -count=1 -run TestCoverageLines -v .
package main_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// coverageBlock is one record of a Go coverage profile: an inclusive span of
// lines and the number of times it ran.
type coverageBlock struct {
	startLine int
	endLine   int
	count     int
}

// fixtureModule and fixtureFile stand in for a real module path and a file
// inside it. coverage-lines.awk strips the module prefix so its output joins
// against repository-relative paths from `git diff`.
const (
	fixtureModule = "example.test/fixture"
	fixtureFile   = "internal/example/example.go"
)

// partialLine is the line the two gates used to disagree about: block one ran
// and block two did not, and both cover it.
const partialLine = 12

// fixtureBlocks deliberately overlap. Every classification Codecov makes is
// represented — a line only in blocks that ran, a line only in blocks that did
// not, and a line in one of each:
//
//	10, 11  hit      (block one only, which ran)
//	12      PARTIAL  (block one ran, block two did not)
//	13, 14  miss     (block two only, which did not run)
//	20      hit      (block three)
//	30, 31  miss     (block four)
var fixtureBlocks = []coverageBlock{
	{startLine: 10, endLine: 12, count: 5},
	{startLine: 12, endLine: 14, count: 0},
	{startLine: 20, endLine: 20, count: 3},
	{startLine: 30, endLine: 31, count: 0},
}

// TestCoverageLinesCountsAPartialLineAgainstYou names the specific defect. A
// line covered by both an executed and an unexecuted block is not covered.
func TestCoverageLinesCountsAPartialLineAgainstYou(t *testing.T) {
	statuses := runCoverageLines(t, fixtureBlocks)

	status, ok := statuses[partialLine]
	if !ok {
		t.Fatalf("line %d is absent from the coverage map; it is inside two blocks", partialLine)
	}
	if status != 0 {
		t.Errorf("line %d reported as covered; it is inside a block that never ran, "+
			"which codecov/patch counts as a partial and against the ratio", partialLine)
	}
}

// TestCoverageLinesAgreesWithCodecov is the parity assertion: the figure
// `make patch-coverage` computes equals the one codecov/patch computes for the
// same profile.
//
// Codecov's arithmetic is written out here in Go rather than read back from the
// script, so the two are independent statements of the rule. If
// coverage-lines.awk goes back to counting a line as covered when ANY block
// ran, this fixture reports 50.0% locally against Codecov's 37.5% and the test
// says so.
func TestCoverageLinesAgreesWithCodecov(t *testing.T) {
	statuses := runCoverageLines(t, fixtureBlocks)

	// The local figure, computed the way patch-coverage.sh's join does it: a
	// changed line counts toward the denominator when the profile knows it, and
	// toward the numerator when its status is 1. Every fixture line is treated
	// as changed.
	covered := 0
	for _, status := range statuses {
		if status == 1 {
			covered++
		}
	}
	local := percent(covered, len(statuses))

	hits, misses, partials := classifyAsCodecov(fixtureBlocks)
	codecov := percent(hits, hits+misses+partials)

	if partials == 0 {
		t.Fatal("the fixture contains no partially covered line, so it cannot " +
			"demonstrate the disagreement it exists to rule out")
	}
	if local != codecov {
		t.Errorf("make patch-coverage would report %.1f%% (%d/%d) and codecov/patch "+
			"%.1f%% (%d hits, %d misses, %d partials) for the same profile; the two "+
			"gates enforce one documented figure and must compute it the same way",
			local, covered, len(statuses), codecov, hits, misses, partials)
	}
}

// classifyAsCodecov sorts every line the profile mentions into Codecov's three
// buckets: a line is a hit when every block covering it ran, a miss when none
// did, and a partial when both are true of it.
func classifyAsCodecov(blocks []coverageBlock) (hits, misses, partials int) {
	ran := make(map[int]bool)
	idle := make(map[int]bool)
	for _, block := range blocks {
		for line := block.startLine; line <= block.endLine; line++ {
			if block.count > 0 {
				ran[line] = true
			} else {
				idle[line] = true
			}
		}
	}

	for line := range ran {
		if idle[line] {
			partials++
			continue
		}
		hits++
	}
	for line := range idle {
		if !ran[line] {
			misses++
		}
	}
	return hits, misses, partials
}

// percent is the ratio both gates report, with an empty denominator reported as
// zero rather than as a division by it.
func percent(part, whole int) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole) * 100
}

// runCoverageLines writes blocks as a coverage profile, runs the real
// scripts/coverage-lines.awk over it, and returns the line-to-status map the
// gate joins its diff against.
func runCoverageLines(t *testing.T, blocks []coverageBlock) map[int]int {
	t.Helper()

	profile := filepath.Join(t.TempDir(), "coverage.out")
	if err := os.WriteFile(profile, []byte(renderProfile(blocks)), 0o600); err != nil {
		t.Fatalf("writing the fixture profile: %v", err)
	}

	// A missing awk is a failure, not a skip: the gate this checks is written in
	// awk, so "awk is unavailable" means the gate could not have run either.
	command := exec.CommandContext(t.Context(),
		"awk", "-v", "module="+fixtureModule, "-f", "scripts/coverage-lines.awk", profile)
	out, err := command.Output()
	if err != nil {
		t.Fatalf("running scripts/coverage-lines.awk: %v", err)
	}

	return parseStatuses(t, string(out))
}

// renderProfile writes blocks in the format `go test -coverprofile` emits. The
// column numbers and the statement count are fixed: neither reaches the merge
// rule under test.
func renderProfile(blocks []coverageBlock) string {
	var out strings.Builder
	out.WriteString("mode: set\n")
	for _, block := range blocks {
		fmt.Fprintf(&out, "%s/%s:%d.2,%d.16 1 %d\n",
			fixtureModule, fixtureFile, block.startLine, block.endLine, block.count)
	}
	return out.String()
}

// parseStatuses reads the script's `file line status` triples, requiring every
// one of them to be about the fixture file.
func parseStatuses(t *testing.T, out string) map[int]int {
	t.Helper()

	statuses := make(map[int]int)
	for row := range strings.SplitSeq(strings.TrimSpace(out), "\n") {
		if row == "" {
			continue
		}
		fields := strings.Fields(row)
		if len(fields) != 3 {
			t.Fatalf("coverage-lines.awk emitted %q, want `file line status`", row)
		}
		if fields[0] != fixtureFile {
			t.Fatalf("coverage-lines.awk emitted path %q, want %q — the module "+
				"prefix has to be stripped or the join against `git diff` paths "+
				"matches nothing and the gate reports a pass it never computed",
				fields[0], fixtureFile)
		}
		line, err := strconv.Atoi(fields[1])
		if err != nil {
			t.Fatalf("coverage-lines.awk emitted line %q: %v", fields[1], err)
		}
		status, err := strconv.Atoi(fields[2])
		if err != nil {
			t.Fatalf("coverage-lines.awk emitted status %q: %v", fields[2], err)
		}
		statuses[line] = status
	}

	if len(statuses) == 0 {
		t.Fatal("coverage-lines.awk emitted nothing for a profile with four blocks")
	}
	return statuses
}
