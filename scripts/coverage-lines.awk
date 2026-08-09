# coverage-lines.awk — map a Go coverage profile to "file line status" triples,
# where status is 1 for a covered line and 0 for one that is not.
#
# Read with -v module=<go module path>, which is stripped from the profile's
# import paths so the result joins against repository-relative diff paths.
#
# Called by patch-coverage.sh. It is a file of its own rather than a heredoc in
# that script because the merge rule below is the whole of the local gate's
# agreement with codecov/patch, and a rule that decides whether a gate passes
# should be readable and testable on its own (#29, TestCoverageLinesAgreesWithCodecov).
#
# ── The merge rule ───────────────────────────────────────────────────────────
#
# A Go profile records blocks, not lines, and blocks overlap: one line can be
# inside several of them with different execution counts. Something has to
# decide what such a line is worth, and the two gates enforcing the same 85%
# figure used to decide it differently.
#
# Codecov calls a line with both an executed and an unexecuted block a PARTIAL,
# and its ratio is hits / (hits + misses + partials) — so a partial counts in
# the denominator and not in the numerator, which is to say it counts against
# you. `go tool cover` has no partial category at all, and this script used to
# inherit that by taking the optimistic view: covered if ANY block ran. On PR
# #28 that was worth 3.6 points — `make patch-coverage` reported 88.0% and
# passed, codecov/patch reported 84.35% and failed, on an identical diff.
#
# So the rule is pessimistic: a line is covered only if EVERY block covering it
# ran. That makes the local figure identical to Codecov's, because a Codecov
# partial and a Codecov miss both land here as a 0 and Codecov's denominator
# already counts them the same way.
#
# The direction matters as much as the agreement. The local gate is a
# pre-flight check, so where the two could drift it should be the strict one:
# an over-strict local gate costs a contributor some tests, and an over-generous
# one costs them a red CI run on a diff `make verify` called green — which is
# the parity claim in CLAUDE.md failing in the only direction that misleads.

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
        # An unexecuted block wins: see "The merge rule" above. A line already
        # recorded as covered is demoted, and one already recorded as uncovered
        # is never promoted.
        if (status == 0 || !(key in seen)) {
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
