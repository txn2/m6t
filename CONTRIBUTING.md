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
  0BSD. CI enforces this. By contributing you agree your contribution is
  licensed under [Apache 2.0](LICENSE).

## Development

Prerequisites and build instructions land with
[#1](https://github.com/txn2/m6t/issues/1) (Wails v2, Go, Node). Until then:
`git clone`, read DESIGN.md, pick an unclaimed issue.

## Code conventions

- Go backend under `internal/`, one package per service (DESIGN.md §3.2).
  `gofmt` + `go vet` clean; tests for parsers, protocol framing, and config.
- Frontend under `frontend/` — React + TypeScript, eslint/prettier clean.
- External binaries (`git`, `kubectl`, `helm`) are invoked through the shared
  exec helper — argv logged, stdout/stderr captured separately, never via a
  shell. No exceptions; this is a safety property, not a style preference.
- Anything that mutates a cluster goes through the validate → diff → confirm →
  apply pipeline. New mutation paths that skip confirmation will not be merged.

## Reporting bugs and proposing features

Use the issue templates. For security issues see [SECURITY.md](SECURITY.md) —
do not open a public issue.
