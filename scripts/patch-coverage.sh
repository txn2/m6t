#!/usr/bin/env bash
# patch-coverage.sh — coverage of the lines this change touches.
#
# Mirrors codecov's patch target locally so `make verify` fails before the
# commit rather than after the push. New code is held to a HIGHER bar than the
# total floor, which is what lets the total ratchet upward instead of drifting
# down one lightly-tested change at a time.
#
# Compatible with bash 3.2+ (macOS default).
set -euo pipefail

THRESHOLD="${PATCH_COVERAGE_THRESHOLD:-85}"
COVERAGE_FILE="${COVERAGE_FILE:-coverage.out}"
BASE_BRANCH="${BASE_BRANCH:-main}"

TMPDIR_PC=$(mktemp -d)
trap 'rm -rf "$TMPDIR_PC"' EXIT

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -f "$COVERAGE_FILE" ]; then
    echo "ERROR: $COVERAGE_FILE not found."
    echo "Run 'make test' (or 'go test -coverprofile=coverage.out ./...') first."
    exit 1
fi

# Prefer origin/main so the base matches CI's PR base; fall back to a local
# main for offline work. A missing base is a hard error: silently skipping the
# gate is how uncovered code reaches CI.
if git rev-parse --verify --quiet origin/"$BASE_BRANCH" >/dev/null 2>&1; then
    BASE_REF="origin/$BASE_BRANCH"
elif git rev-parse --verify --quiet "$BASE_BRANCH" >/dev/null 2>&1; then
    BASE_REF="$BASE_BRANCH"
else
    echo "ERROR: neither origin/$BASE_BRANCH nor $BASE_BRANCH is reachable."
    echo "       Run 'git fetch origin $BASE_BRANCH' and retry."
    exit 1
fi

MERGE_BASE=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || true)
if [ -z "$MERGE_BASE" ]; then
    echo "ERROR: could not compute a merge base with $BASE_REF."
    exit 1
fi

# Include uncommitted and staged work so verify gates the code about to be
# committed, not only what is already committed.
if git diff --quiet HEAD 2>/dev/null; then HAS_UNCOMMITTED=""; else HAS_UNCOMMITTED="yes"; fi
if git diff --cached --quiet 2>/dev/null; then HAS_STAGED=""; else HAS_STAGED="yes"; fi

if [ "$MERGE_BASE" = "$(git rev-parse HEAD)" ] && [ -z "$HAS_UNCOMMITTED" ] && [ -z "$HAS_STAGED" ]; then
    echo "SKIP: HEAD is the merge base and there are no uncommitted changes."
    exit 0
fi

# `git diff` does not see untracked files, so a brand-new package would sail
# through this gate reporting "no Go source changes". Refuse to run instead:
# a silent skip is indistinguishable from a pass, and that is precisely the
# parity hole the gate exists to close.
UNTRACKED_GO=$(git ls-files --others --exclude-standard -- '*.go' \
    | grep -v '_test\.go$' \
    | grep -v '^frontend/node_modules/' || true)
if [ -n "$UNTRACKED_GO" ]; then
    echo "ERROR: these Go files are untracked, so 'git diff' cannot see them and"
    echo "       this gate would skip them silently:"
    echo "$UNTRACKED_GO" | sed 's/^/  /'
    echo ""
    echo "Run 'git add -N' on them (intent to add) so the diff includes them:"
    echo "  git add -N \$(git ls-files --others --exclude-standard -- '*.go')"
    exit 1
fi

# ── Extract changed lines and coverage into flat files, then join with awk ───

MODULE=$(grep -m1 '^module ' go.mod | awk '{print $2}')

# Step 1: git diff -> "file line" pairs, one per added/changed line.
# Non-test .go files only; pure-deletion hunks are skipped.
git diff --unified=0 "$MERGE_BASE" | awk '
    /^\+\+\+ b\// {
        f = substr($0, 7)
        if (f !~ /\.go$/ || f ~ /_test\.go$/) f = ""
        # npm dependencies ship Go source; go.mod ignores it and so do we.
        if (f ~ /^frontend\/node_modules\//) f = ""
        next
    }
    f != "" && /^@@ / {
        # @@ -old[,oldcount] +new[,newcount] @@
        n = split($0, tokens, " ")
        plus_part = ""
        for (t = 1; t <= n; t++) {
            if (substr(tokens[t], 1, 1) == "+") {
                plus_part = substr(tokens[t], 2)
                break
            }
        }
        if (plus_part == "") next

        nc = split(plus_part, sc, ",")
        start = sc[1] + 0
        count = (nc > 1) ? sc[2] + 0 : 1
        if (count == 0) next  # pure deletion
        for (i = start; i < start + count; i++) {
            print f, i
        }
    }
' | sort -u > "$TMPDIR_PC/changed.txt"

if [ ! -s "$TMPDIR_PC/changed.txt" ]; then
    echo "SKIP: no Go source changes detected (test-only or deletion-only diff)."
    exit 0
fi

# Step 2: coverage.out -> "file line status" triples (1 = covered).
# A line inside several blocks counts as covered if ANY block ran.
awk -v module="$MODULE" '
    /^mode:/ { next }
    {
        # module/path/file.go:startLine.startCol,endLine.endCol numStmts count
        split($0, parts, ":")
        full_path = parts[1]
        rest = parts[2]

        sub("^" module "/", "", full_path)

        split(rest, a, ",")
        split(a[1], sl, ".")
        start_line = sl[1] + 0

        split(a[2], b, " ")
        split(b[1], el, ".")
        end_line = el[1] + 0
        count = b[3] + 0

        status = (count > 0) ? 1 : 0
        for (ln = start_line; ln <= end_line; ln++) {
            key = full_path SUBSEP ln
            if (status == 1 || !(key in seen)) {
                seen[key] = status
            }
        }
    }
    END {
        for (key in seen) {
            split(key, kp, SUBSEP)
            print kp[1], kp[2], seen[key]
        }
    }
' "$COVERAGE_FILE" | sort > "$TMPDIR_PC/coverage.txt"

# Step 3: join changed lines against the coverage map. Lines the compiler does
# not treat as statements (declarations, comments) are absent from the profile
# and simply do not count toward the denominator.
awk '
    NR == FNR {
        cov[$1 ":" $2] = $3
        next
    }
    {
        key = $1 ":" $2
        if (key in cov) {
            exec_count[$1]++
            total_exec++
            if (cov[key] == 1) {
                cov_count[$1]++
                total_cov++
            } else {
                uncov[$1] = uncov[$1] " " $2
            }
        }
        if (!($1 in seen_file)) {
            files[++nf] = $1
            seen_file[$1] = 1
        }
    }
    END {
        for (i = 1; i <= nf; i++) {
            for (j = i + 1; j <= nf; j++) {
                if (files[i] > files[j]) {
                    tmp = files[i]; files[i] = files[j]; files[j] = tmp
                }
            }
        }

        for (i = 1; i <= nf; i++) {
            f = files[i]
            e = exec_count[f] + 0
            c = cov_count[f] + 0
            if (e == 0) {
                printf "  %-60s  (no executable changed lines)\n", f
            } else {
                pct = (c / e) * 100
                printf "  %-60s  %d/%d (%.1f%%)", f, c, e, pct
                if (uncov[f] != "") {
                    printf "  uncovered lines:%s", uncov[f]
                }
                printf "\n"
            }
        }

        printf "\n"
        if (total_exec + 0 == 0) {
            print "SKIP: no executable changed lines found in the diff."
            print "RESULT:SKIP" > "/dev/stderr"
            exit 0
        }

        patch_pct = (total_cov / total_exec) * 100
        printf "Patch coverage: %d/%d executable changed lines = %.1f%%\n", total_cov, total_exec, patch_pct
        printf "RESULT:%.1f\n", patch_pct > "/dev/stderr"
    }
' "$TMPDIR_PC/coverage.txt" "$TMPDIR_PC/changed.txt" \
    >"$TMPDIR_PC/report.txt" 2>"$TMPDIR_PC/result.txt"

# ── Verdict ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Patch Coverage Report ==="
echo "Base: $BASE_REF (merge-base: $(echo "$MERGE_BASE" | cut -c1-10))"
echo ""

cat "$TMPDIR_PC/report.txt"

RESULT_LINE=$(grep '^RESULT:' "$TMPDIR_PC/result.txt" 2>/dev/null || echo "RESULT:SKIP")
RESULT_VAL="${RESULT_LINE#RESULT:}"

if [ "$RESULT_VAL" = "SKIP" ]; then
    echo "SKIP: no executable changed lines found in the diff."
    echo "=== End Patch Coverage ==="
    exit 0
fi

echo "Threshold: ${THRESHOLD}%"
FAIL=$(awk "BEGIN {print ($RESULT_VAL < $THRESHOLD) ? 1 : 0}")
if [ "$FAIL" -eq 1 ]; then
    echo ""
    echo "FAIL: patch coverage ${RESULT_VAL}% is below the ${THRESHOLD}% floor."
    echo "Add tests for the uncovered lines listed above."
    echo "=== End Patch Coverage ==="
    exit 1
fi

echo "PASS"
echo "=== End Patch Coverage ==="
