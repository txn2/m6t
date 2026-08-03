package main_test

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
)

// The frontend suppressions ratchet.
//
// ESLint's bulk-suppressions file is what lets the complexity gates run at
// error level without a mass rewrite: existing violations are baselined, new
// ones fail. That is only true while the baseline shrinks. Left unwatched it
// becomes the opposite — the place violations go to be forgotten, one
// `--suppress-rule` at a time.
//
// So the count is pinned, and it only ratchets down. Growing it requires
// editing the number here, in the PR that grows it, with the reason.
//
// Run: go test -run TestFrontendSuppressionsOnlyShrink .

// maxFrontendSuppressions caps the total suppressed ESLint violations.
//
// Pinned at 0: the scaffold has none, and the complexity budgets were sized so
// that honest code passes. A PR that needs to raise this is a PR that should
// have split a component instead.
//
// Prune entries a fixed file no longer needs before touching this number:
//
//	cd frontend && npx eslint . --prune-suppressions
const maxFrontendSuppressions = 0

// suppressionsFile is the ESLint bulk-suppressions baseline, at ESLint's
// default location.
const suppressionsFile = "frontend/eslint-suppressions.json"

// TestFrontendSuppressionsOnlyShrink fails when the baseline holds more
// suppressed violations than the pin allows.
func TestFrontendSuppressionsOnlyShrink(t *testing.T) {
	total, byRule := countSuppressions(t, readRepoFile(t, suppressionsFile))
	t.Logf("%s: %d suppressed violations (ceiling %d)", suppressionsFile, total, maxFrontendSuppressions)

	if total > maxFrontendSuppressions {
		t.Errorf("%s suppresses %d violations (%s), exceeding the ceiling of %d — "+
			"fix the code rather than baselining it; if a suppression is genuinely "+
			"warranted it needs maintainer sign-off and a lower ceiling in the same PR",
			suppressionsFile, total, strings.Join(byRule, ", "), maxFrontendSuppressions)
	}
}

// countSuppressions totals the suppressed violations in an ESLint
// bulk-suppressions document and summarizes them per rule.
//
// The format is {file: {rule: {count: n}}}, so the total is the sum of every
// count — a file-level or rule-level tally would undercount a single file that
// baselines many violations of one rule.
func countSuppressions(t *testing.T, raw string) (total int, byRule []string) {
	t.Helper()
	var doc map[string]map[string]struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("parsing %s: %v", suppressionsFile, err)
	}

	perRule := map[string]int{}
	for _, rules := range doc {
		for rule, entry := range rules {
			perRule[rule] += entry.Count
			total += entry.Count
		}
	}
	for rule, n := range perRule {
		byRule = append(byRule, fmt.Sprintf("%s x%d", rule, n))
	}
	sort.Strings(byRule)
	return total, byRule
}

// TestSuppressionCountingSumsEveryEntry pins the counter. A counter that
// tallied files or rules instead of violations would report 1 for a file
// baselining twenty violations of one rule — the exact case the ratchet is
// meant to stop.
func TestSuppressionCountingSumsEveryEntry(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantTotal int
		wantRules []string
	}{
		{
			name:      "empty baseline",
			raw:       `{}`,
			wantTotal: 0,
		},
		{
			name:      "one file, one rule, many violations",
			raw:       `{"src/a.ts":{"complexity":{"count":20}}}`,
			wantTotal: 20,
			wantRules: []string{"complexity x20"},
		},
		{
			name: "counts sum across files and rules",
			raw: `{"src/a.ts":{"complexity":{"count":2},"sonarjs/cognitive-complexity":{"count":1}},
			       "src/b.ts":{"complexity":{"count":3}}}`,
			wantTotal: 6,
			wantRules: []string{"complexity x5", "sonarjs/cognitive-complexity x1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			total, byRule := countSuppressions(t, tt.raw)
			if total != tt.wantTotal {
				t.Errorf("total = %d, want %d", total, tt.wantTotal)
			}
			if strings.Join(byRule, ",") != strings.Join(tt.wantRules, ",") {
				t.Errorf("byRule = %v, want %v", byRule, tt.wantRules)
			}
		})
	}
}
