# CLAUDE.md — working agreement for AI contributors

This file is the leash. It is not advisory: every rule below is enforced by a
gate, and the gates are the reason the rules can be trusted rather than hoped
for. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the human-facing version of
the same process and [DESIGN.md](DESIGN.md) for what m6t is.

## The one rule that contains the others

**Run `make verify` before proposing any commit.** It is the CI-parity gate:
every check it runs has an equivalent CI job at the same threshold. A green
verify on a diff means CI cannot fail on that diff. Proposing a commit without
it means asking a human to find out in CI what you could have found in three
minutes.

## Architecture map

```
main.go                   composition root: embeds frontend/dist, hands the
                          assembled options to the Wails runtime
internal/app/             the Wails binding layer — the object bound to the
                          frontend, plus the window options. Composes the
                          services below it; they never import it.
internal/buildinfo/       link-time build identity. A dependency root: it
                          imports nothing first-party.
frontend/src/             React + TypeScript UI (Vite)
frontend/wailsjs/         GENERATED bindings — never hand-edit; run
                          `make bindings`
scripts/                  gate implementations (patch coverage, CodeQL gate)
.semgrep/                 repo-specific SAST rules
```

Backend services from later issues (git, pty, kube exec, kube watch, helm, fs
watcher — DESIGN.md §3.2) go in `internal/<service>/`. They are siblings: a
service that needs another's behaviour takes an interface in its constructor
and lets `internal/app` wire the two together. `depguard` enforces this; it is
not a style preference, it is what keeps the service graph from becoming a
ball of mud.

There is no `pkg/`. m6t exposes no public Go API.

## Hard rules

**Acceptance criteria before code.** State what "done" means for the change,
in terms someone could check, before writing the implementation. A change
whose success condition appears only after the code is a change that will be
justified by whatever it happens to do.

**No lint suppression.** `//nolint`, `#nosec`, `eslint-disable`, a new entry in
`frontend/eslint-suppressions.json`, a new line in
`scripts/codeql-baseline.txt` — none of these go in without maintainer sign-off
in the PR. Fix the code, not the linter. If a rule is genuinely wrong for this
repo, change the rule in config with the reasoning in the diff, so the decision
is reviewed once instead of scattered across call sites.

**No tautological tests.** A test must encode the expected output and fail when
the logic breaks. `assert(f(x) == f(x))`, asserting a mock returns what it was
told to return, or asserting a constant equals itself are all worse than no
test: they consume the coverage budget while proving nothing. Mutation testing
(`make verify-release`) audits this — a suite that survives mutants is treated
as broken.

**No vaporware.** Every package must be imported by non-test code reachable
from `main`. Do not add a package, an interface, or an exported method for a
future issue. Code that compiles but is not wired in is dead code that has to
be maintained anyway.

**Adversarial review precedes verify.** Before running the gate, review the
diff with the goal of *refuting* it: find the input that breaks it, the error
path with no test, the test that would pass with the implementation deleted.
Report what you found, including when the answer is "the change is wrong."
A review that concludes "looks good" without having tried to break the change
has not happened.

**Report outcomes faithfully.** If a gate fails, say so and show the output. If
you skipped a step, say which. Never describe a check as passing because it
would probably pass.

## Gates and what they mean

| Gate | Floor | Notes |
|---|---|---|
| `make test` | — | `-race -shuffle=on -count=1`; order-dependent tests fail |
| `make coverage-report` | 80% total | the floor only moves up |
| `make patch-coverage` | 85% of changed lines | new code is held above the total |
| `make lint` | 0 new issues | cyclomatic ≤ 10, cognitive ≤ 15 |
| `make frontend-lint` | 0 new issues | the same two numbers, in eslint |
| `make security` | clean | gosec + govulncheck |
| `make semgrep` | clean | `p/golang` + `.semgrep/` |
| `make licenses` | allowlist | MIT / BSD / Apache-2.0 / ISC / 0BSD only |
| `make build-check` | builds | Go build + `go mod verify` + Wails smoke build |
| `make mutate` | 60% efficacy | `verify-release` only, before tagging |

The coverage and pin figures are stated in the Makefile, `ci.yml`,
`codecov.yml` and `CONTRIBUTING.md`. `pins_test.go` fails the build if any two
disagree — a documented gate figure is a claim, and claims get verified.

## Working with this codebase

- **External binaries** (`git`, `kubectl`, `helm`) are invoked with an argv
  slice, never through a shell, and argv is logged. A repository path
  containing shell metacharacters must be inert. `.semgrep/go-security.yml`
  enforces the shell part.
- **Cluster mutations** go through validate → diff → confirm → apply
  (DESIGN.md §6.1). A new path that reaches a cluster without confirmation
  will not be merged.
- **The bound surface is the API.** Wails exports every exported method of a
  bound object to TypeScript. Adding one widens the backend's public API —
  `internal/app` keeps its exported surface to what the UI actually calls.
- **Generated code** (`frontend/wailsjs/`) is regenerated with `make bindings`
  and committed; `make bindings-check` fails when it is stale.
- **Errors from other packages get wrapped** (`wrapcheck`), and error strings
  are lowercase and unpunctuated (`revive`). Git and kubectl stderr is
  surfaced verbatim to the user — do not translate tool errors into prose.

## Git

Work on a feature branch. `main` changes only by PR merge. Do not commit until
the maintainer has approved the change, and do not push — hand the maintainer
the commands.
