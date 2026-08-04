# m6t

**m6t** (m‑anifes‑t) is a cross-platform desktop workbench for managing
Kubernetes manifest repositories: one tab per manifest repo, git awareness,
light schema-aware YAML editing, a diff-before-apply Kubernetes workflow with
Helm support, and a real embedded terminal built for running
[Claude Code](https://claude.ai/code) alongside your manifests.

> **Status: design phase.** The v1 design is complete ([DESIGN.md](DESIGN.md));
> implementation is tracked in [issue #17](https://github.com/txn2/m6t/issues/17)
> against the [v1 milestone](https://github.com/txn2/m6t/milestone/1). There is
> no usable build yet.

## Why

Managing fleets of manifest repos doesn't need an IDE — it needs a small set of
things done extremely well:

- **Projects** — each cloned manifest repo is a top-level tab.
- **Git** — status badges in the file tree, pull / commit / push, proper diffs.
- **Editing** — CodeMirror-based YAML with Kubernetes schema diagnostics, and
  markdown preview. Light by design.
- **Apply** — every cluster mutation goes validate → diff → confirm → apply,
  with explicit per-project context binding and typed confirmation for
  protected clusters. Plain YAML and Helm (render→apply or true releases).
- **Terminal** — real PTY terminals per project (cwd at the repo root), sized
  for full-screen Claude Code sessions.

Everything m6t does to a repo or a cluster is something you could have typed
yourself (`git`, `kubectl`, `helm`) — it wraps your tooling and credentials,
and never stores either.

## Architecture

Go backend (git/PTY/kubectl/client-go/helm) + [Wails](https://wails.io) system
webview frontend (React, xterm.js, CodeMirror 6). Targets macOS, Linux, and
Windows. See [DESIGN.md](DESIGN.md) for the full architecture, decisions and
rationale, and roadmap.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues are organized by `area/*`
labels; [DESIGN.md](DESIGN.md) is the source of truth for scope and
architecture decisions.

## License

[Apache 2.0](LICENSE). All dependencies are permissively licensed
(MIT/BSD/Apache-2.0), enforced by a CI license gate.
