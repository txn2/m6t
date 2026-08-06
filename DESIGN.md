# m6t — Design Document

**m6t** (m‑anifes‑t) is a cross-platform desktop workbench for managing Kubernetes
manifest repositories. It replaces a general-purpose IDE (WebStorm + git plugin +
Kubernetes plugin + built-in terminal) with a purpose-built tool that does exactly
five things well:

1. One tab per project, where a project is a cloned git repository of manifests.
2. A file tree with git change awareness, plus pull / push and diffs.
3. Light, schema-aware YAML editing and markdown viewing/editing.
4. Diff-before-apply Kubernetes workflows for plain YAML and Helm charts.
5. A first-class embedded terminal for running Claude Code per project.

License: Apache 2.0. All dependencies are permissive (MIT / BSD / Apache 2.0) and
compatible with a possible future commercial edition. No Qt, no GPL/LGPL linkage.

Targets: macOS, Linux, Windows.

---

## 1. Goals and non-goals

### Goals

- Fast startup, small footprint; a tool you leave open all day next to a browser.
- The cluster you are pointed at is always unmistakable. Applying to the wrong
  context should be structurally hard, not just discouraged.
- Everything the app does to a cluster or a repo is something the user could have
  typed themselves (`git`, `kubectl`, `helm`). The app is a workbench over the
  user's own tooling and credentials, never a credential store or a proxy.
- The terminal is a real PTY running the user's real shell. Claude Code runs in it
  exactly as it would in a standalone terminal.

### Non-goals (v1)

- Not a general IDE. No language servers beyond YAML, no debugger, no plugin API.
- Not a GitOps controller. m6t applies what you tell it to; it does not reconcile.
- No kustomize support (deliberately deferred; see roadmap).
- No secrets tooling (sops, helm-secrets, sealed-secrets awareness) — repos are
  treated as plain text; secrets are handled outside this tool.
- No cluster administration (node views, RBAC editing, CRD browsing). The live
  view is scoped to objects declared in the open project's manifests.

---

## 2. Decisions and rationale

| Area | Decision | Rationale / rejected alternatives |
|---|---|---|
| App shell | **Go backend + Wails (system webview)** | Go fits the txn2 toolchain and owns git/PTY/kube logic natively. Small binaries. Rejected: Electron (100MB+, Node backend), Tauri (Rust ecosystem weaker for kube/git/pty), native Go GUIs (terminal and editor widgets too immature — the two components that matter most). |
| Wails version | **v2 (stable)**; migrate to v3 when it reaches beta | Single-window app needs nothing v3-exclusive. High-throughput data bypasses the JS bridge anyway (see §3.3). |
| Frontend | **TypeScript + React + Vite** | xterm.js and CodeMirror 6 are framework-agnostic; React chosen for ecosystem depth. All MIT. |
| Terminal | **xterm.js + real PTY** (WebGL renderer) | The proven embedded-terminal stack (VS Code's). Cross-platform today, MIT, and fast enough for full-screen `claude` and `vim` (§8). |
| Editor | **CodeMirror 6** | Lighter than Monaco, better touch/perf profile, MIT. "Light yaml editing" does not need Monaco's weight. |
| Git | **Shell out to system `git`**, parse porcelain output | Inherits SSH agent, credential helpers, signing config, and every edge case for free. Rejected: go-git (auth and worktree edge-case parity is a permanent tax). |
| Kube mutations | **Shell out to `kubectl`** (`diff`, `apply`, `delete`) | Inherits kubeconfig, exec auth plugins (OIDC / EKS / GKE / AKS), server-side apply semantics. |
| Kube reads | **client-go, read-only** | Live status and drift views without polling through kubectl. Watch/list only; the client-go path never mutates. |
| Helm | **Both modes**: render→apply and real releases | `helm template` output feeds the same diff/apply pipeline as plain YAML; a separate release mode wraps `upgrade --install` / `history` / `rollback` for charts genuinely managed as releases. Shell out to `helm`. |
| Manifest formats | Plain YAML directories + Helm charts | Kustomize deferred. |
| Secrets | Out of scope | Handled outside the tool. |

External binaries required at runtime: `git`, `kubectl`, `helm` (helm only if a
project contains charts). m6t detects them at startup and per-project, and
degrades gracefully with a clear "install X / not found on PATH" state rather
than failing obscurely.

---

## 3. Architecture

### 3.1 Process model

One process, three layers:

```
┌──────────────────────────────────────────────────────────┐
│ Wails app (single window)                                │
│                                                          │
│  Frontend (webview)          Go backend                  │
│  ─ React UI                  ─ project registry/config   │
│  ─ CodeMirror 6              ─ git service (exec git)    │
│  ─ xterm.js instances        ─ pty service (ConPTY/pty)  │
│  ─ diff / markdown views     ─ kube exec service         │
│                              ─ kube watch service        │
│         ▲       ▲            ─ helm service (exec helm)  │
│         │ Wails │            ─ fs watcher (fsnotify)     │
│         │ bind- │            ─ loopback stream server    │
│         │ ings  └────────────────────┐                   │
│         │                            │                   │
│         └── WebSocket (127.0.0.1) ───┘                   │
└──────────────────────────────────────────────────────────┘
          │                    │
          ▼                    ▼
   child processes:      client-go (read-only)
   git, kubectl, helm,        │
   $SHELL (PTYs)              ▼
                         clusters (user's kubeconfig)
```

### 3.2 Go backend services

- **Project registry** — the list of managed repos and their per-project settings
  (§4). Owns lifecycle: add (clone or point at existing checkout), open, remove.
- **Git service** — wraps `git` invocations per project: `status --porcelain=v2`,
  `diff`, `log`, `pull`, `push`, branch info. Emits change events. Nothing here
  writes the index — see §7.
- **FS watcher** — fsnotify on each open project's worktree and `.git/HEAD` /
  `.git/refs`; debounced events drive tree badges and editor reload prompts.
  Polling fallback where fsnotify is unreliable (network mounts).
- **PTY service** — spawns the user's shell (`$SHELL` / PowerShell) in a PTY:
  creack/pty on macOS/Linux, ConPTY on Windows (via a wrapper such as
  aymanbagabas/go-pty, MIT). PTYs are owned by the backend and survive project-tab
  switches; closing the app terminates them cleanly.
- **Kube exec service** — builds and runs `kubectl` commands with explicit
  `--context` and `--namespace` from project settings (never inherited implicitly
  from the user's current-context), captures structured output for the UI.
- **Kube watch service** — client-go informers/watches scoped to the objects
  declared in the open project's manifests (matched by GVK + namespace + name).
  Computes health via kstatus (sigs.k8s.io/cli-utils, Apache 2.0). Read-only by
  construction: the shared client is built with no mutating verbs used anywhere.
- **Helm service** — chart discovery (`Chart.yaml`), `helm template` rendering,
  and release operations (`upgrade --install`, `list`, `status`, `history`,
  `rollback`) in release mode.

### 3.3 Frontend ↔ backend transport

Two channels, chosen by payload profile:

- **Wails bindings** for RPC (open file, git pull, run apply, get project
  list): request/response, typed, low volume.
- **Loopback WebSocket server** (127.0.0.1, random port, per-launch bearer token
  required on connect) for streams: PTY input/output (binary frames), live
  status events from the watch service, long diff/render output. This bypasses
  the JS bridge for throughput-sensitive data and keeps the design portable
  across Wails v2/v3.

---

## 4. Projects and configuration

App configuration lives in the OS config dir (`~/Library/Application Support/m6t`,
`~/.config/m6t`, `%AppData%\m6t`), primarily `projects.yaml`:

```yaml
projects:
  - name: infra-prod
    path: ~/workspace/ops/infra-prod
    kube:
      context: prod-us-west        # required before any kube action is enabled
      namespace: default
      protected: true              # typed confirmation on apply/delete/rollback
    helm:
      defaultValues: [values.yaml, values-prod.yaml]
```

Nothing is written into the managed repos in v1 — they stay pristine manifest
repos. (A shared in-repo `.m6t.yaml` for team defaults is a v2 candidate.)

The kube context binding is **per project and explicit**. m6t never uses the
kubeconfig current-context; a project with no bound context shows the cluster
panel and apply actions disabled with a "bind a context" prompt.

---

## 5. UI

Single window. Top-level tabs are projects; each project tab contains:

```
┌──────────────────────────────────────────────────────────────┐
│  [ infra-prod ]  [ team-x ]  [ + ]                           │
├────────────┬───────────────────────────────┬─────────────────┤
│ File tree  │  Editor area (tabs)           │ Cluster panel   │
│            │   - CodeMirror (YAML)         │                 │
│  M deploy… │   - Markdown view/edit        │  ⬢ prod-us-west │
│  A svc.yaml│   - Diff viewer               │  ns: default    │
│            │   - Helm render view          │                 │
│  (git      ├───────────────────────────────┤  Deployment ✓   │
│  badges)   │  Terminal tabs                │  Service     ✓  │
│            │   [zsh] [claude] [+]          │  CronJob     ⟳  │
│            │   xterm.js, cwd = project     │  drift: 1 obj   │
├────────────┴───────────────────────────────┴─────────────────┤
│ ⎇ main ↑1 ↓0 · 3 changed   │   ⬢ prod-us-west / default 🔒   │
└──────────────────────────────────────────────────────────────┘
```

- **File tree**: git status badges (modified/added/untracked/conflicted),
  directory-level rollup, context menu for git and kube actions on files/dirs.
- **Editor**: CodeMirror 6 with YAML syntax, folding, and schema-aware
  diagnostics for Kubernetes kinds (bundled JSON schemas, validated in the Go
  backend on save/idle — kubeconform-style). Markdown files render to a preview
  with an edit toggle. This is deliberately "light editing": no refactoring, no
  multi-file operations.
- **Cluster panel**: live health (from the watch service + kstatus) for every
  object declared in the project, and a drift indicator when live objects differ
  from the checked-in manifests (server-side dry-run comparison, computed on
  demand — not continuous).
- **Context visibility**: the bound context/namespace appears in the cluster
  panel, the status bar, and — for `protected: true` projects — as a persistent
  colored border/accent on the whole project tab. This is the single most
  important safety feature in the app.
- **Terminal**: multiple terminal tabs per project, cwd at the project root.
  A one-click "Claude Code" action opens a terminal tab running `claude`.
  Sessions keep running when the user switches project tabs (components are
  hidden, not destroyed; PTYs live in the backend).

---

## 6. Kubernetes workflows

### 6.1 Plain YAML: the diff → apply pipeline

Every mutation goes through the same pipeline, invoked on a file, a directory,
or a Helm render:

1. **Validate** — schema check + `kubectl apply --dry-run=server` for the
   selection; failures block with readable errors.
2. **Diff** — `kubectl diff` output rendered as a side-by-side/unified view.
   "No changes" is a first-class result, not an empty screen.
3. **Confirm** — the confirm dialog restates target context + namespace.
   Protected projects require typing the context name.
4. **Apply** — `kubectl apply` (server-side apply configurable per project),
   streamed output, followed by the cluster panel reflecting new live status.

Delete follows the same shape (`--dry-run=server`, listing what will be
removed, protected-confirm, `kubectl delete`).

### 6.2 Helm

Chart discovery: any directory containing `Chart.yaml` is presented as a chart
node in the tree, with its values files. Two modes per chart:

- **Render → apply** (default): `helm template` with the selected values files;
  rendered manifests open in the render view and feed the §6.1 pipeline
  unchanged. Helm's release tracking is not involved; the cluster only ever
  sees plain applied objects.
- **Release mode** (opt-in per chart): m6t wraps the Helm lifecycle —
  `helm upgrade --install` (with `helm diff` when the plugin is present,
  otherwise a pre-render `kubectl diff` best-effort), release list, `status`,
  `history`, and `rollback`. Release actions honor the same protected-project
  confirmation rules. A chart in release mode shows its release state in the
  cluster panel instead of raw object status.

The mode is stored in project settings so a chart can't accidentally be applied
both ways from the UI without an explicit switch.

---

## 7. Git workflows

v1 scope mirrors actual daily use, not a git client:

- Status-driven change markers in the file tree: every changed path tinted and badged where it lives, and a tree-header toggle that filters the tree down to just those paths (deletions included, struck through, since they are in no directory listing). There is no separate changes list — a second list of the same paths cost a fixed share of the sidebar to say what the tree already knew.
- Pull (rebase per repo config), push, current branch + ahead/behind in the status bar.
- Diff viewer for working-tree changes and for a file's last commit.
- Branch switching (existing branches). Branch creation, log browsing, stash,
  and history tooling are v1.x (§10).

**Staging and committing are not m6t's.** The agent in the terminal (§5) does that
work, running the user's own `git` in the user's own worktree — so m6t offers no commit
box and no stage/unstage control, and its bound surface has no method that writes the
index. Two writers of one index, only one of which the agent can see, is two tools
disagreeing about one repository. A row's badge reports the worktree side when a path
carries both, because the row is the file on disk.

**Conflicts are resolved in the terminal.** v1 ships no merge tool, so a conflicted path
gets the conflict tint and marker in the tree, and the status bar says where to go about
it — the one instruction that has to be visible whatever the sidebar is showing, because
an unmerged path stops a pull and a branch switch.

All operations run the system `git`; failures surface stderr verbatim (the user
knows how to read git errors — do not translate them).

---

## 8. Terminal

- xterm.js with the WebGL renderer, fit/search/web-links addons (all MIT).
- Real PTY per terminal tab (creack/pty; ConPTY on Windows), user's login shell,
  environment inherited from the app plus `PWD` at the project root.
- I/O over the loopback WebSocket (binary), no chunk-size games through the JS
  bridge. Target: comfortable full-screen `claude` and `vim` sessions.
- Scrollback, copy/paste, and font/theme settings shared with the app theme.

---

## 9. Cross-platform and packaging

| | macOS | Linux | Windows |
|---|---|---|---|
| Webview | WKWebView (system) | WebKitGTK (webkit2gtk-4.1 dependency) | WebView2 (auto-installed by Wails installer) |
| PTY | creack/pty | creack/pty | ConPTY (Windows 10 1809+) |
| Packaging | .app + notarized dmg | AppImage first; deb/rpm and Flatpak later | NSIS installer |

Known risks, accepted:

- System-webview rendering drift (WebKit vs WebView2) — mitigated by keeping the
  UI to well-supported CSS and testing the terminal + editor on all three early
  (they are the drift-sensitive components).
- WebKitGTK availability/version skew across distros — AppImage bundling policy
  decided during packaging spike.

## 9.1 License inventory

| Component | License |
|---|---|
| Wails, React, Vite, xterm.js, CodeMirror 6, creack/pty, go-pty | MIT |
| TypeScript, client-go, sigs.k8s.io/cli-utils (kstatus), sigs.k8s.io/yaml | Apache 2.0 |
| fsnotify | BSD-3 |
| git, kubectl, helm | external binaries — invoked, never linked; no license coupling |

Every linked dependency is Apache-2.0-compatible and safe for a future
commercial edition. A CI check (e.g. go-licenses + a JS license checker) gates
new dependencies against an allowlist.

---

## 10. Roadmap

**v1 (everything above):** project tabs, git basics + diff, CM6 YAML/markdown
editing with schema diagnostics, diff→apply pipeline, Helm render + release
modes, live status/drift panel, embedded terminal + Claude Code action,
protected-context confirmations, mac/linux/windows builds.

**v1.x:** branch create/log/stash, kustomize support, in-repo `.m6t.yaml` shared
settings, helm-diff plugin integration polish, Flatpak/deb/rpm, per-project
environment variables for terminals.

**v2 candidates:** multi-window, sops/secrets awareness, yaml-language-server
(full LSP) instead of bundled-schema validation, apply history/audit log,
Wails v3 migration.

---

## 11. Open questions

- Wails v2 → v3 timing: revisit at implementation start; the transport design
  (§3.3) makes this low-risk either way.
- Drift detection cost: server-side dry-run per object is O(objects) API calls;
  on-demand-only in v1, but batching strategy needs a spike for large projects.
- Bundled Kubernetes JSON schema versioning: pin per minor release vs fetch per
  cluster version (offline behavior favors bundling; decide in the validation
  spike).
