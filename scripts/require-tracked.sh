#!/usr/bin/env bash
# require-tracked.sh — refuse to run a git-diff-based gate while files it should
# be checking are untracked.
#
# `git diff` does not see untracked files. Any gate built on it therefore skips
# every NEW file silently, and a silent skip is indistinguishable from a pass:
# the gate reports success on code it never looked at, while CI — which reads
# the committed tree — sees the problem. That is not a hypothetical. It let 11
# lint issues reach CI on PR #21 after `make verify` reported green.
#
# Every gate in this repository that shells out to `git diff` calls this first.
# TestGitDiffGatesRequireTrackedFiles fails the build if one stops doing so.
#
# Usage: require-tracked.sh <label> <pathspec>...
set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "usage: require-tracked.sh <label> <pathspec>..." >&2
    exit 2
fi

LABEL="$1"
shift

# node_modules is excluded for the same reason go.mod ignores it: npm ships Go
# source that is not ours to track.
UNTRACKED=$(git ls-files --others --exclude-standard -- "$@" \
    | grep -v '^frontend/node_modules/' || true)

if [ -z "$UNTRACKED" ]; then
    exit 0
fi

echo "ERROR: the $LABEL gate compares against git, which cannot see untracked files."
echo "       These would be skipped silently — reported as a pass without being checked:"
echo "$UNTRACKED" | sed 's/^/  /'
echo ""
echo "Mark them intent-to-add so the diff includes them, then re-run:"
printf '  git add -N'
for spec in "$@"; do
    printf " %s" "$spec"
done
echo ""
exit 1
