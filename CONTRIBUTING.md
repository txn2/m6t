# Contributing to m6t

Thanks for your interest in m6t.

## Ground rules

- **[DESIGN.md](DESIGN.md) is the source of truth** for scope and architecture.
  Decisions recorded there (stack, transport, kubectl-vs-client-go split,
  safety model) are settled for v1 — open an issue to propose changing one
  rather than sending a PR that quietly diverges.
- **One issue per PR.** v1 work is broken into dependency-ordered issues; see
  the [tracking issue](https://github.com/txn2/m6t/issues/17). Comment on an
  issue before starting so work isn't duplicated.
- **Licensing:** all linked dependencies must be MIT, BSD, Apache-2.0, ISC, or
  0BSD. The `make licenses` gate enforces this. By contributing you agree your
  contribution is licensed under [Apache 2.0](LICENSE).

## The process

Every change follows the same path, no exceptions:

1. **Branch.** All work happens on a feature branch. `main` only changes by
   PR merge — never by direct commit or push.
2. **Adversarial review.** Before verification, the diff gets an adversarial
   code review whose job is to *refute* the change: find the failure scenario,
   the tautological test, the unhandled error — not to confirm the approach.
   Findings are addressed before proceeding.
3. **`make verify`.** The full CI-parity gate must pass locally. If `verify`
   is green, CI cannot fail on the same diff — that parity is a maintained
   invariant, not an aspiration (see Quality gates below).
4. **Review and merge.** The PR is reviewed and merged by a maintainer.

## Quality gates

`make verify` runs every gate CI runs, with the same thresholds. The floors
(these exact figures are mechanically checked against the Makefile, CI, and
codecov config by a gate-figure agreement test — changing one place fails the
build):

- Total coverage must be at least **80%**.
- Coverage of the lines your change touches must be at least **85%** — new
  code is held above the total floor so the total only ratchets upward.
- Cyclomatic complexity ≤ **10** and cognitive complexity ≤ **15** per
  function. The frontend carries the same two numbers as eslint `complexity`
  and `sonarjs/cognitive-complexity`, so one budget governs both languages.
- Mutation-testing efficacy ≥ **60%** (`make verify-release`, required before
  tagging a release).
- gosec, govulncheck, and semgrep clean; CodeQL gated against a baseline.

Structural ratchets (see the
[structural gates issue](https://github.com/txn2/m6t/issues/19)) are plain Go
tests that fail on architectural decay: package-size budgets, an import
ratchet, exported-surface budgets, a god-object budget on the backend
coordinator struct (AST field/method ceilings pinned to actuals), dead-package
and noop-interface detection, and an integration guard proving integration
tests actually ran. **Ceilings carry zero slack and only move down.** Raising
one is a regression that must be explicitly justified in the PR.

Hard rules:

- **No lint suppression.** `//nolint`, `#nosec`, eslint-disable and friends
  are never added without maintainer sign-off in the PR. Fix the code, not
  the linter.
- **No tautological tests.** Tests encode expected outputs; they must fail
  when the logic breaks. Mutation testing audits this — a test suite that
  survives mutants is treated as broken.
- **No vaporware.** Every package must be imported by non-test code reachable
  from the app entrypoint. Code that compiles but isn't wired in is dead code
  and fails the build.

## Development

### Prerequisites

- **Go 1.26.5** and **Node.js 22+**.
- Platform webview toolchain: Xcode command line tools on macOS;
  `libgtk-3-dev` and `libwebkit2gtk-4.1-dev` on Debian/Ubuntu; WebView2 (which
  the Wails installer provides) on Windows.

### The toolchain

`make verify` runs pinned tools, and `make tools-check` refuses to proceed when
a local version differs from the one CI uses — a gosec that silently drops a
rule CI enforces is how a real vulnerability reaches a PR. Install exactly
these (currently golangci-lint v2.11.4 / gosec v2.28.0):

```sh
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.11.4
go install github.com/securego/gosec/v2/cmd/gosec@v2.28.0
go install github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
go install golang.org/x/vuln/cmd/govulncheck@latest
go install golang.org/x/tools/cmd/deadcode@latest
go install github.com/google/go-licenses@latest
pip3 install semgrep
```

`make tools-check` names anything still missing or mismatched, with the command
to fix it.

### Everyday commands

```sh
make dev          # run the app with hot reload
make verify       # the full gate — run before proposing a commit
make test         # Go tests with -race -shuffle=on
make frontend-test
make build        # build the desktop app for this platform
make bindings     # regenerate frontend/wailsjs after changing bound methods
make help         # every target
```

`make verify` takes a few minutes on a cold cache. Run it anyway: it is the
difference between finding a problem locally and finding it in review.

## Code conventions

- Go backend under `internal/`, one package per service (DESIGN.md §3.2).
  There is no `pkg/` — m6t exposes no public Go API.
- Frontend under `frontend/` — React + TypeScript, eslint/prettier clean, with
  complexity gates mirroring the Go side.
- External binaries (`git`, `kubectl`, `helm`) are invoked only through the
  shared exec helper — argv logged, stdout/stderr captured separately, never
  via a shell. This is a safety property, not a style preference.
- Anything that mutates a cluster goes through the validate → diff → confirm →
  apply pipeline. New mutation paths that skip confirmation will not be merged.

## Reporting bugs and proposing features

Use the issue templates. For security issues see [SECURITY.md](SECURITY.md) —
do not open a public issue.
