#!/usr/bin/env python3
"""Count blocking CodeQL alerts in a SARIF file.

A blocker is a result that is BOTH:
  - level == "error" OR rule security-severity >= 7.0, AND
  - not present in the baseline file.

The security-severity clause is what keeps `make codeql` honest against CI:
low-confidence taint findings (go/request-forgery and friends) emit
`level=note` locally but carry `security-severity=9.1`, and GitHub Code
Scanning blocks on them. Without this clause the local run reports clean while
CI rejects the same diff.

The baseline (default scripts/codeql-baseline.txt) lists alerts the gate
ignores. Format: one `<rule_id> <path>:<line>` per line; `#` starts a comment.
An entry there is a claim that the finding is a false positive or mitigated at
runtime, and it needs the same justification in the PR as a lint suppression.

Usage: codeql-gate.py PATH_TO_SARIF [PATH_TO_BASELINE]
Exits 1 with details when NEW blockers are found, 0 otherwise.
"""

import json
import os
import sys

# CVSS-style cutoff for "high"; CRITICAL (>= 9.0) is caught by the same test.
MIN_BLOCKING_SEVERITY = 7.0

DEFAULT_BASELINE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "codeql-baseline.txt"
)


def load_baseline(path: str) -> set[str]:
    """Return the set of "rule_id path:line" tokens in the baseline.

    A missing file is fine — the gate then runs in "no baseline" mode, which is
    the strictest configuration.
    """
    accepted: set[str] = set()
    if not os.path.exists(path):
        return accepted
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            accepted.add(line)
    return accepted


def alert_key(rule_id: str, loc: str, line: int | str) -> str:
    """Format the (rule, location) tuple the baseline matches on."""
    return f"{rule_id} {loc}:{line}"


def count_blockers(sarif: dict, baseline: set[str]) -> list[str]:
    """Return descriptions of every NEW blocker (one not in the baseline)."""
    blockers: list[str] = []
    for run in sarif.get("runs", []):
        severities: dict[str, float] = {}
        rule_levels: dict[str, str] = {}
        for rule in run.get("tool", {}).get("driver", {}).get("rules", []):
            sev_raw = rule.get("properties", {}).get("security-severity", "0") or "0"
            try:
                severities[rule.get("id")] = float(sev_raw)
            except (TypeError, ValueError):
                severities[rule.get("id")] = 0.0
            rule_levels[rule.get("id")] = rule.get("defaultConfiguration", {}).get(
                "level", "note"
            )
        for result in run.get("results", []):
            rule_id = result.get("ruleId", "<unknown>")
            # CodeQL usually omits per-result "level" and carries it on the
            # rule's defaultConfiguration instead. Reading only the result lets
            # error-level rules below the severity cutoff pass unnoticed.
            level = result.get("level") or rule_levels.get(rule_id, "note")
            sev = severities.get(rule_id, 0.0)
            if not (level == "error" or sev >= MIN_BLOCKING_SEVERITY):
                continue
            location = result.get("locations", [{}])[0].get("physicalLocation", {})
            loc = location.get("artifactLocation", {}).get("uri", "?")
            line = location.get("region", {}).get("startLine", "?")
            if alert_key(rule_id, loc, line) in baseline:
                continue
            blockers.append(f"{rule_id} (level={level}, sev={sev}) at {loc}:{line}")
    return blockers


def main(argv: list[str]) -> int:
    """Load the SARIF report and fail when it contains new blocking alerts."""
    if len(argv) not in (2, 3):
        print("usage: codeql-gate.py PATH_TO_SARIF [PATH_TO_BASELINE]", file=sys.stderr)
        return 2
    sarif_path = argv[1]
    baseline_path = argv[2] if len(argv) == 3 else DEFAULT_BASELINE
    try:
        with open(sarif_path, encoding="utf-8") as f:
            sarif = json.load(f)
    except OSError as e:
        print(f"FAIL: cannot read SARIF: {e}", file=sys.stderr)
        return 2
    baseline = load_baseline(baseline_path)
    blockers = count_blockers(sarif, baseline)
    if not blockers:
        print(f"CodeQL: no new blocking issues ({len(baseline)} baselined).")
        return 0
    print(f"FAIL: CodeQL found {len(blockers)} NEW blocking issue(s):")
    for blocker in blockers:
        print(f"  - {blocker}")
    print(
        "\nIf a finding is genuinely a false positive or is mitigated at "
        "runtime, add it to scripts/codeql-baseline.txt with the rationale in "
        "the PR; otherwise fix the code."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
