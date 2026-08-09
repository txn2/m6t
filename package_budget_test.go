package main_test

import (
	"bufio"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
)

// packagePin is one package's ratchet entry. Every first-party package has
// exactly one, and the table below IS the import ratchet: adding a package
// means adding an entry in the same PR, which makes package sprawl a
// deliberate act instead of a side effect.
type packagePin struct {
	// loc caps hand-written, non-test lines in the package.
	loc int
	// exported caps package-scope exported identifiers. Pinned to the actual
	// with zero slack: widening a seam should be visible in review, and the
	// diff that widens it is where the justification belongs.
	exported int
	// why records what the package is for, so a reviewer reading a ratchet
	// bump can judge whether the growth belongs there.
	why string
}

// structuralPins is the ratchet table, pinned to today's measurements.
//
// Reproduce every number with:
//
//	go test -count=1 -run 'TestPackageSizeBudget|TestPackageExportedSurfaceBudget' -v .
//
// Exported-surface counts are pinned at actuals with zero slack. The LOC
// ceilings are the one exception and carry headroom — see locCeilingNote,
// because that difference is a judgement call a reviewer should be able to
// challenge rather than discover.
var structuralPins = map[string]packagePin{
	rootPackageDir: {
		loc: 60, exported: 0,
		why: "composition root: embeds the frontend, hands options to the Wails runtime",
	},
	"internal/app": {
		// 700 -> 760 in #58. session.go is two delegating bindings and their
		// doc comments; the App gains one field, the session store's handle.
		// The room #9's note set aside here was earmarked for #10's kube
		// bindings, and #52's GitBlame took part of it before this did, so the
		// number moves rather than the service being squeezed in under it.
		// 704 is today's actual.
		//
		// 760 -> 900 in #10. kube.go is four bindings over three services and
		// holds no logic of its own: KubeContexts and Tools delegate outright,
		// KubeBinding is one registry read and one Resolve, and KubeCheck is
		// the one line that matters — it resolves the target here rather than
		// accepting one over the bridge, so the cluster a call reaches always
		// comes from the registry and never from a frontend that may have gone
		// stale. 796 is today's actual.
		//
		// 900 -> 1150 in #11, and this is the raise that has to answer the
		// failure message rather than talk around it, because the message says
		// to decompose and this package cannot be decomposed. It IS the bound
		// surface: depguard forbids a service importing internal/app, so the
		// only other place these functions could live inverts the layering.
		// That argument is already made at length below for #9; what is new
		// here is what it bought.
		//
		// The whole of the diff → apply pipeline's bridge landed in kube.go:
		// five bindings, the target resolution they share, and the protected
		// confirmation. Of those, one thing is behavior rather than delegation
		// and it is deliberate — `confirm` refuses a mutation on a protected
		// binding whose typed context does not match exactly, before any
		// process is created. It is here because a guard that lived in the
		// dialog that collects the answer would be a guard the next caller
		// gets to forget; DESIGN.md §6.1 makes it the app's rule, and this is
		// the app. `aim` and `resolveBinding` are free functions rather than
		// methods for the same reason the god-object note gives, so this raise
		// buys bindings and their doc comments and not a wider coordinator.
		//
		// 1066 is today's actual, of which roughly a third is code. 1150 is
		// that plus the same slim follow-up room the rest of this table
		// carries — deliberately not enough for #14's Helm bridge to move in
		// under, which arrives as its own set of bindings and will have to
		// make this argument again on its own terms.
		loc: 1150, exported: 2,
		why: "Wails binding layer: the bound object, the window options, and the adapters that join sibling services",
	},
	"internal/git": {
		// 27 -> 21 exported and 1000 -> 900 LOC in #39. Stage, Unstage,
		// Commit and the three argument errors only they could return
		// (ErrNoPaths, ErrOutsideRoot, ErrEmptyMessage) are gone: the UI has
		// no control that writes the index, so under the no-vaporware rule
		// the service methods behind those controls are not "kept for #35",
		// they are unreachable code. Both figures ratchet down rather than
		// standing still, because a ceiling left where a package used to be
		// is room for the next thing to move in unnoticed.
		// 900 -> 1100 and 21 -> 25 in #52. See locCeilingNote.
		//
		// 1100 -> 950 in #53. run.go left for internal/gitexec, taking 207
		// lines with it and the eleven of `mutate` besides. 882 is today's
		// actual and 950 is the same slim follow-up room the rest of this table
		// carries — a ceiling left at 1100 is 218 lines of room for the next
		// thing to move in unnoticed, which is what this table exists to stop.
		//
		// The surface does not move: run.go exported nothing. Its two sentinels
		// became gitexec.ErrNoGit and gitexec.ErrNotARepository, and this
		// package still turns them into Availability values rather than
		// re-exporting them.
		loc: 950, exported: 25,
		why: "git service: DESIGN.md §7 over the system git — porcelain v2 status with its two degraded states reported as values rather than errors, porcelain blame for the editor's per-line attribution, and the writes the terminal is a bad place for (pull, push, branch switch)",
	},
	"internal/gitexec": {
		// Measured: 278 lines in one file, of which the runner itself is about
		// eighty and the rest is why each of its decisions is the one that has
		// to hold — see locCeilingNote for what those are. 320 is that plus the
		// same slim follow-up room the rest of this table carries.
		//
		// It is deliberately the smallest allowance here. This package has one
		// job and no second one available to it: a parser belongs to whichever
		// reader needs that format, and a git operation belongs to the service
		// that offers it. What would fit under a larger ceiling is exactly what
		// must not arrive — the moment this package knows what `status` prints,
		// every git reader in the repository is coupled to that.
		loc: 320, exported: 5,
		why: "git runner: the one place a git process is started, and the conditions every git call runs under — locale, lock discipline, deadlines, git's stderr passed out unedited. A dependency root importing nothing first-party (#53)",
	},
	"internal/buildinfo": {
		loc: 150, exported: 2,
		why: "link-time build identity; a dependency root importing nothing first-party",
	},
	"internal/project": {
		// 650 -> 750 in #41. 750 -> 1150 and 9 -> 12 exported in #10. See
		// locCeilingNote.
		loc: 1150, exported: 12,
		why: "project registry: the persistent list of manifest repositories, their per-project settings, the per-subtree cluster bindings those settings resolve to, and the order the tab strip shows them in",
	},
	"internal/kubeconfig": {
		// Measured: 102 lines in one file. 200 is that plus the follow-up room
		// every measured package here carries — and it is deliberately small,
		// because the only thing this package is allowed to grow into is more
		// ways to READ a kubeconfig. A write path, a client builder or a
		// current-context selector would each be a different package's job.
		loc: 200, exported: 3,
		why: "read-only kubeconfig reader: the contexts a project can be bound to (DESIGN.md §4), listed through client-go's loading rules so m6t's list agrees with kubectl's",
	},
	"internal/kubeexec": {
		// Measured: 214 lines in one file. 500 is that plus room for #11's
		// diff/apply pipeline, which is the next set of subcommands to go
		// through this same argv builder. The ceiling refuses a second
		// responsibility, not more subcommands: everything here is one
		// function deep behind exec, and the moment it starts parsing what
		// kubectl printed it has become a different package.
		loc: 500, exported: 6,
		why: "kube exec service: kubectl with --context and --namespace stated on every invocation and no code path that omits either (DESIGN.md §3.2, §4)",
	},
	"internal/tools": {
		// Measured: 163 lines in one file. 250 is that plus follow-up room.
		// The list of binaries m6t drives is fixed by DESIGN.md §2 at three,
		// so this package has nowhere to grow except into per-tool version
		// comparison — which belongs to whichever feature needs a minimum
		// version, not here.
		loc: 250, exported: 2,
		why: "external tool detection: whether git, kubectl and helm are installed and at what version, as a state the UI degrades on rather than an error it fails on (DESIGN.md §2)",
	},
	"internal/session": {
		// Measured: #58 landed it at 463 lines across two files — the session
		// schema with the normalization every reader of an editable file needs,
		// and the confined atomic store. 550 is that plus the same proportional
		// follow-up room internal/pty and internal/project carry.
		loc: 550, exported: 9,
		why: "workspace session: what the window was showing when it was last closed — active project, per-project editor tabs, tree shape and terminal tabs — as a scratch file beside the registry that is replaced by defaults rather than reported when it will not parse",
	},
	"internal/pty": {
		loc: 750, exported: 7,
		why: "PTY service: session lifecycle, scrollback and platform termination for the embedded terminal",
	},
	"internal/stream": {
		loc: 900, exported: 5,
		why: "loopback stream server: token-authenticated WebSocket transport for PTY I/O and backend-push events",
	},
	"internal/watch": {
		// 21 -> 22 exported in #38. One name, ReadPrefixes: the bounded head
		// read the tree classifies a Kubernetes manifest from. It is a
		// capability this package did not have — ReadFile answers "give me
		// this file to edit" and enforces an editing size limit for it, which
		// is the wrong contract for "tell me what these thirty files are" —
		// and the two identifiers it needed besides (the prefix length, the
		// oversized-batch sentinel) are unexported precisely because no
		// caller names them.
		//
		// 22 -> 23 exported and 1250 -> 1300 LOC in #11. One name, Resolve: a
		// repository-relative path turned into the absolute one an external
		// process is handed, having been proved to name something inside the
		// worktree.
		//
		// It is here rather than in internal/kubeexec or internal/app because
		// of what it has to do to be honest. kubectl opens the path itself, in
		// another process, outside the os.Root every operation in this package
		// works through — so the confinement has to happen before the path
		// leaves, and the only way to establish it is to stat through that
		// same root. A caller that joined the two strings itself would get a
		// path that had been concatenated rather than checked, and a symlink
		// out of the repository would resolve quietly inside kubectl. The
		// runtime check is exactly the half fs.ValidPath cannot do.
		//
		// 1256 is today's actual; 1300 is that plus the usual follow-up room.
		//
		// #61 spent most of that room: 1288 now, for one predicate and the
		// paragraph explaining which filesystem event this watcher deliberately
		// ignores and what that costs. The ceiling does not move for it — the
		// next thing to arrive here has twelve lines, and should be a
		// decomposition rather than a raise. fsnotify.go and poll.go are two
		// change-detection strategies behind one Events seam and are the split
		// that exists if one is needed.
		loc: 1300, exported: 23,
		why: "file tree and watcher: os.Root-confined lazy directory listing and CRUD, file content read/write for the editor (#7), bounded prefix reads for content-based file classification (#38), plus fsnotify/polling change detection for the workbench tree (DESIGN.md §3.2)",
	},
}

// locCeilingNote explains why the LOC ceilings carry headroom while every other
// figure here is pinned to the actual.
//
// A LOC ceiling set to a package's exact current line count is not a ratchet,
// it is a freeze: one more line of doc comment in buildinfo.go would fail the
// build. The number has to represent the size at which a package stops being
// readable in one sitting.
//
// internal/pty and internal/stream are measured rather than policy-seeded.
//
//   - internal/pty landed with #2 at 644 lines across six files, and 750 is that
//     plus room for the follow-up fixes a new service attracts — not enough room
//     for a second service to move in alongside it. #3 added the detach seam and
//     took it to 705, inside the ceiling set for exactly that kind of follow-up.
//   - internal/stream landed with #3 at 838 lines across six files: a wire
//     protocol server — auth, framing, backpressure, two endpoints — with the
//     protocol itself specified in PROTOCOL.md rather than inferred from the
//     handlers. 900 is that plus the same kind of headroom, and the services
//     that will push events onto its /events channel (#5) plug into the existing
//     envelope rather than adding endpoints, so this number should hold.
//
// internal/app's ceiling moved from 200 to 260 in #3. The reason is a shape
// this repo will see again: sibling services must not import each other, so the
// binding layer is where a service is adapted onto another's declared seam, and
// #3 put the first such adapter (pty.Manager -> stream.Terminals) in
// terminals.go. The ceiling is today's 201 plus room for one more adapter of the
// same size. What it still refuses is behavior: an adapter that grows past
// translation, or a service implemented here instead of composed here, is what
// this number exists to bring to review.
//
// 260 -> 400 in #5, and this is the raise most worth arguing with. The registry
// bindings in projects.go are 82 lines for five methods, four of them a
// delegation to internal/project with an error wrap and the fifth a native
// dialog — the shape this ceiling wants, not the shape it refuses. What actually
// moved the number is that the binding layer now composes three services instead
// of two, and each arrives with a doc comment explaining why its operation
// belongs on the bridge rather than behind the transport. 400 is today's 343
// plus room for one more service of that size. The check on this is not the line count but the god-object
// gate: if these lines were behavior rather than delegation, App would be
// growing fields, and maxAppFields is still pinned at one handle per service.
//
// internal/project is measured: it landed with #5 at 570 lines across three
// files — the registry and its read-modify-write cycles, the confined atomic
// store, and the project schema — and 650 is that plus the follow-up room a new
// service attracts, the same allowance internal/pty got in #2.
//
// 650 -> 750 in #41, and this is a raise where the failure message says to
// decompose instead, so it needs the argument rather than the number.
//
// What arrived is one operation and two fields, not a second responsibility.
// Reorder is the fourth read-modify-write cycle beside Add, Remove and Update,
// against the same file, under the same mutex, with the same refusal to write
// over a config it could not parse; DisplayName and Color join Settings because
// the tab strip has to be renameable without re-keying a registry that
// terminals, editor tabs and watchers are all filed under. Of the 96 lines,
// roughly a third are code and the rest are this repository's deliberate prose
// — including the paragraph explaining why a stale order is refused rather than
// reconciled, which is the part of Reorder a reviewer should actually be
// reading.
//
// The decomposition was tried on paper and rejected, for internal/git's reason.
// The obvious seam is store.go — the os.Root-confined atomic YAML write — but
// the registry is its only caller, and depguard forbids one service importing
// another, so extracting it means a second dependency-root exception beside
// internal/buildinfo to put a boundary where the code has no consumer for one.
// The seam that DOES exist is the settings UI (DESIGN.md §8): a kube/helm
// editor is a different consumer of this data and is expected to land as its
// own package rather than inside this ceiling.
//
// 679 is today's actual; 750 is that plus the same proportional follow-up room
// the rest of this note's measured packages carry.
//
// 750 -> 1000 in #10, and the paragraph above is the one this raise has to
// answer: it says the settings UI is expected to land as its own package rather
// than inside this ceiling. It did — the editor is React, in
// frontend/src/components, and none of it is here. What landed here is
// binding.go: Scope, Binding and Kube.Resolve, the rules that turn a project's
// stored settings and a repository-relative path into the context and namespace
// kubectl will be told.
//
// That is schema, not UI, and it cannot live anywhere else. Resolve is a method
// on Kube reading fields Kube owns, and depguard forbids one service importing
// another — so extracting it would mean either exporting the settings schema to
// a second package or granting a second dependency-root exception beside
// internal/buildinfo, both to move sixty lines of resolution away from the type
// they resolve. The alternative that was actually considered and rejected is
// worse than either: leaving Kube's fields to be read directly by callers. A
// caller that reads Kube.Context for a path some scope overrides gets the wrong
// cluster, which is the exact failure the binding exists to prevent, so the
// resolution has to sit on the type and the raw fields have to stop being the
// thing anyone reads.
//
// 902 is today's actual, of which roughly a third is code. 1000 is that plus
// the usual follow-up room.
//
// 1000 -> 1150 later in the same PR, when the binding UI moved: the project
// default is set in the project panel and a folder override is made on the
// folder, in the tree. That put BindScope and UnbindScope here — the two writes
// that add and remove one override — and they are in this package for a reason
// the paragraph above already gives in a different form. They are
// read-modify-write cycles against projects.yaml, which is editable by hand
// while m6t runs, so doing them anywhere else means doing them outside the
// mutex that makes every other write on this file safe. The frontend asks for
// "bind this folder"; it never reads a scope list, edits it and writes it back.
//
// Both live in binding.go beside the model they write rather than in
// registry.go beside the project-level CRUD, which is the decomposition this
// ceiling's failure message asks for, done at the only boundary that exists:
// the package cannot be split, because depguard forbids one service importing
// another and Kube's fields are what Resolve reads.
//
// 1021 is today's actual; 1150 is that plus the usual room. #11's diff/apply
// consumes a resolved Binding — it does not add to how one is computed or
// stored — so this should be the last raise the binding asks for.
//
// internal/watch is measured: it landed with #6 at 807 lines across five
// files — os.Root-confined List/Create/Rename/Delete, the fsnotify watcher and
// its coalescer, the polling fallback, and the Start/Stop/Shutdown service —
// and 950 is that plus the same proportional follow-up room internal/pty and
// internal/project carry.
//
// 950 -> 1250 in #7. content.go adds ReadFile/WriteFile — the editor's file
// content I/O — as a sixth file in the same package rather than a new
// sibling: it reuses the exact os.Root confinement and .git exclusion
// List/Create/Rename/Delete already established, which a new internal/editor
// package could only get by duplicating (siblings may not import each
// other). 1107 is today's actual; 1250 is that plus the same proportional
// follow-up room the rest of this note's measured packages carry.
//
// content.go is 302 of those lines, and most of what makes it that long is
// the part worth reviewing: EOL classification that refuses to guess at a
// mixed file, and an atomic scratch-then-rename write that carries the
// target's mode across. Both exist because the issue's acceptance criterion
// is that a save shows up in `git diff` as exactly the edit — a naive
// truncate-and-write would satisfy the happy path and quietly rewrite every
// line of a mixed-EOL file, or drop a 0755 script to 0640, on the paths
// nobody demonstrates. The atomic half deliberately mirrors
// internal/project/store.go, which already writes the registry this way for
// the same durability reason.
//
// The exported surface moved 13 -> 21: FileContent, ReadFile, WriteFile,
// LargeFileThreshold, MaxEditableSize, and three sentinel errors
// (ErrIsDirectory, ErrTooLarge, ErrBinaryFile) are the content operations'
// whole seam, pinned with the usual zero slack.
//
// internal/git is measured: it landed with #8 at 542 lines across three
// files — the status types and their two degraded states, the exec runner,
// and the porcelain v2 parser — and 650 is that plus the same proportional
// follow-up room internal/project carries. The parser is the bulk of it and
// the part that should be allowed to grow: every record kind it does not
// handle is a badge the tree cannot show, and #9's diff viewer reads the same
// format's sibling commands.
//
// The exported surface is 15: Status, FileStatus, Branch and Load are the
// operation, State and Availability are the two enumerations that cross the
// bridge, and the nine constants are their values. They are exported because
// TypeScript compares against them — the frontend's badge and status-bar
// logic is written against these strings, so they are wire constants in the
// same sense internal/stream's type names are.
//
// 650 -> 1000 and 15 -> 27 in #9, and this one is a raise where the failure
// message says to decompose instead, so it needs the argument rather than the
// number. #8's `why` above said "read-only" because #8 was; #9 is the other
// half of the same DESIGN.md §7 sentence, against the same binary, through the
// same runner, under the same rule that git's stderr reaches the user
// unedited. The package is four files with one job each — the wire types, the
// exec runner, the porcelain v2 parser, the mutations — and 428 of its 902
// lines are code; the rest is this repository's deliberate prose, which is
// what makes a raw line count read high here for a package that is not
// actually large.
//
// The decomposition was tried on paper and rejected. Splitting the writer into
// internal/gitops leaves both halves needing runGit, which cannot be shared
// without a third package for it — and depguard forbids one service importing
// another, so that shape only compiles by adding a second dependency-root
// exception beside internal/buildinfo. Three packages and a loosened layering
// rule, to put a seam somewhere the code does not have one, is a worse
// artifact than this raise. A seam that DOES exist is #35's diff viewer: it
// parses a different format for a different consumer and shares only the
// binary, so it is expected to land as its own package rather than inside this
// ceiling.
//
// That last sentence is struck in #53, and the paragraph it belongs to had the
// answer in it the whole time. It called "a third package for the runner, and a
// second dependency-root exception" the cost of the split, and treated that cost
// as the argument against — while naming the parser as the seam that did exist.
// Both halves were backwards. The runner is what has more than one consumer and
// what nothing else can safely duplicate; the parsers have exactly one consumer
// each. #52 hit the same wall from the other side and deferred rather than
// resolving it. The third package is internal/gitexec, the second exception is
// in .golangci.yml, and they cost 278 lines and one reviewed config change —
// less than either ceiling raise that was taken instead of paying it.
//
// The exported surface goes to 27 with zero slack, as this table requires: the
// original 15 plus eight operations (Stage, Unstage, Commit, Pull, Push,
// Checkout, Branches, Remotes) and the four argument-rejection sentinels
// (ErrNoPaths, ErrOutsideRoot, ErrEmptyMessage, ErrInvalidRef) that callers
// match with errors.Is — the bound surface is a public API, so its refusals
// are part of the contract rather than strings to compare.
//
// 900 -> 1100 and 21 -> 25 in #52, and the paragraph above named this exact
// case as one that should go the other way, so it has to be answered rather
// than quietly overruled. What it said is that a reader parsing a different
// format for a different consumer, sharing only the binary, should land as
// its own package. blame.go is that reader — porcelain blame, for the
// editor's gutter rather than the tree's badges — and it did not land as one.
//
// The reason is the sentence before it, which turns out to bind harder than
// the sentence after: a sibling package cannot reach runGit, so
// internal/blame only compiles by extracting the runner into a second
// dependency-root package beside internal/buildinfo. The runner is not
// incidental here. It is what pins LC_ALL so the not-a-repository match keeps
// working, what passes --no-optional-locks so a read does not publish a
// change event that triggers another read, what bounds a call against a
// hung network mount, and what carries git's stderr out verbatim. A blame
// package that duplicated any of that would be a second answer to a question
// this repository has already answered once; one that imported it would need
// the layering rule loosened for a package with a single consumer.
//
// So the split #35 was told to make is real, and the seam is not where that
// paragraph put it. It is the runner, not the parser — and extracting it is a
// refactor of #8 and #9's code with its own blast radius, which is not
// something to do inside a ticket about a column in the editor. It is #53,
// which blocks #35, rather than something done here.
//
// 1072 is today's actual and 1100 is the same slim follow-up room the rest of
// this table carries — deliberately not enough for #35 to move in under. The
// surface goes to 25 with the usual zero slack: Blame and BlameCommit cross
// the bridge, LoadBlame is the operation, and ErrInvalidPath is a refusal a
// caller matches with errors.Is, the same reason ErrInvalidRef is exported.
//
// internal/gitexec is #53, and it is the extraction the two paragraphs above
// kept arriving at and declining. It is measured at 278 lines in one file:
// Read, Write and WriteRemote, the invocation they build, the environment, and
// classify. Nothing was rewritten in the move except one message — see below.
//
// What makes it a package rather than a file is that its consumers cannot be in
// one. internal/git reads and writes through it today; #35's diff viewer is the
// second reader, and a sibling import is exactly what depguard forbids. The
// alternative every prior ticket took instead — duplicate the runner — is worse
// than it looks, because each of the four things it pins fails silently when
// copied wrong: a missing LC_ALL turns the not-a-repository check into a match
// against a translated string, a missing --no-optional-locks turns a status read
// into a watcher event that triggers another status read (#61), a missing
// deadline turns an unreachable mount into badges that never update again, and a
// summarized stderr turns a git error the user could act on into "exit status
// 1". None of the four has a test that would fail in the copy.
//
// The one behavior that changed: a timed-out call now names the deadline that
// actually expired. classify read the local constant regardless of the
// invocation, so a push cut off at ten minutes reported "timed out after 30s".
// It is a method on the invocation now, which is why the fix is structural
// rather than a corrected constant.
//
// 620 -> 700 in #9. git.go gains the mutating half of the git service: eight
// delegating bindings, each four lines because each names its own operation
// and project in front of what internal/git returned, the way GitStatus
// already does. That uniformity is the growth — a shared one-line wrapper
// would have saved eighteen lines and cost every message the verb that says
// which control the user pressed.
//
// There is no decomposition on offer here and that is structural rather than a
// judgement: this package IS the bound surface, so its size is one function per
// operation the frontend can invoke, and depguard forbids the only other place
// those functions could live (a service importing internal/app inverts the
// layering). Splitting git.go into two files would move lines between files
// this budget sums together, which is the exact gaming the god-object gate
// exists to catch. 625 is today's actual; 700 is that plus room for one more
// service's bindings, which is what #10's kube exec surface will be.
//
// 540 -> 620 in #8. git.go adds one binding (GitStatus) and tree.go's
// adapter gains a second publish. No new service handle came with it: the
// git service is stateless, so unlike #3, #5 and #6 this raise buys a
// delegating binding and its doc comment rather than a composed handle. 538
// is today's actual; 620 is that plus room for one more binding of the same
// size.
//
// 400 -> 540 in #6. tree.go added a fourth composed service (the file-tree
// watcher, internal/watch) the same shape as #3's stream adapter and #5's
// registry bindings: a treeBridge adapter (watch.Events -> stream.Server, the
// PublishTree seam) and four delegating bindings (ListDirectory, CreateEntry,
// RenameEntry, DeleteEntry). 466 is today's actual; 540 is that plus the same
// proportional headroom internal/pty and internal/project carry for one more
// follow-up of this size. internal/project.Registry.Remove changed shape in
// this PR too — it returns the removed project instead of only an error — so
// RemoveProject's watcher-stop no longer needs a second lookup; that is a net
// LOC reduction in internal/app, not a contributor to this raise.
//
// The rest are still seeded as policy, because the services that would let
// them be measured (git, kube, helm; DESIGN.md §3.2) land later:
//
//   - 150 for buildinfo — roughly 2x today's size, so ordinary work does not
//     trip the gate while a package that doubles again arrives in review as a
//     decomposition question.
//   - 60 for the root: main.go does one thing and must keep doing only that.
//
// Both are still policy-seeded after #5 rather than re-pinned: neither package
// changed, so there is no new measurement to pin them to. No other ceiling here
// needs the caveat: counts of packages, files and exported names do not grow
// through ordinary editing.
// internal/session is measured: it landed with #58 at 463 lines across two
// files. state.go is the schema and its normalization, which is the bulk of it
// and the part that has to exist: this file is editable by hand and readable by
// a build that is not this one, so every reference it holds — a selection
// naming a tab, an index into a strip, a terminal's directory — is checked
// against what is actually there before the frontend is handed it. store.go is
// the confined atomic write, deliberately mirroring internal/project/store.go
// rather than sharing it, for the reason that package's own note gives about
// extracting a seam its only caller does not need.
//
// The decomposition question this package invites is the opposite of the usual
// one: why is it not part of internal/project, which already owns a file in the
// same directory? Because the two files have opposite failure rules. A
// projects.yaml that does not parse is an error the user is told about, since
// silently starting from empty would present them with an app that appears to
// have forgotten every project they have. A session.yaml that does not parse is
// replaced by defaults without a word. Putting both behind one package would
// mean one package with two contradictory contracts, and the day someone
// applied the wrong one, the registry is what would be lost.
const locCeilingNote = "internal/pty, internal/stream, internal/app, internal/project, internal/session, internal/watch, internal/git and internal/gitexec are measured; buildinfo and the root are policy-seeded (see locCeilingNote)"

// maxFilesPerPackage stops a package from escaping its LOC budget by fanning
// the same code across many small files.
const maxFilesPerPackage = 8

// generatedMarkerRe matches the canonical generated-code marker
// (https://go.dev/s/generatedcode). A file carrying it is excluded from the
// size budget: generated code is not a package's maintenance burden.
var generatedMarkerRe = regexp.MustCompile(`^// Code generated .* DO NOT EDIT\.?$`)

// packageSize is one package's measured footprint.
type packageSize struct {
	loc   int
	files int
}

// measurePackages returns the non-generated, non-test footprint of every
// first-party package, keyed by repo-relative directory.
func measurePackages(t *testing.T) map[string]packageSize {
	t.Helper()
	sizes := map[string]packageSize{}
	walkGoSource(t, func(file, dir string) {
		generated, loc := countGoFile(t, repoFS, file)
		if generated {
			return
		}
		size := sizes[dir]
		size.loc += loc
		size.files++
		sizes[dir] = size
	})
	return sizes
}

// countGoFile reports whether the named file is generated and, if not, how
// many lines it holds. The marker conventionally precedes the package clause,
// but scanning the whole file is cheap and does not miss one placed after a
// build constraint or license header.
func countGoFile(t *testing.T, fsys fs.FS, file string) (generated bool, loc int) {
	t.Helper()
	f, err := fsys.Open(file)
	if err != nil {
		t.Fatalf("opening %s: %v", file, err)
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			t.Errorf("closing %s: %v", file, closeErr)
		}
	}()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if generatedMarkerRe.MatchString(strings.TrimSpace(scanner.Text())) {
			generated = true
		}
		loc++
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanning %s: %v", file, err)
	}
	return generated, loc
}

// TestPackageSizeBudget fails when a package outgrows its ceiling. Hitting it
// is the signal to decompose the package into cohesive pieces — not to raise
// the number, which defeats the gate.
func TestPackageSizeBudget(t *testing.T) {
	sizes := measurePackages(t)

	var violations []string
	for dir, size := range sizes {
		pin, pinned := structuralPins[dir]
		if !pinned {
			// TestEveryPackageIsPinned reports unpinned packages with the full
			// explanation; skipping here keeps one new package to one failure.
			continue
		}
		t.Logf("%-20s %4d LOC (ceiling %d), %d files (ceiling %d)",
			dir, size.loc, pin.loc, size.files, maxFilesPerPackage)
		if size.loc > pin.loc {
			violations = append(violations, fmt.Sprintf(
				"%s: %d LOC exceeds its ceiling of %d — decompose the package, do not raise the ceiling (%s)",
				dir, size.loc, pin.loc, locCeilingNote))
		}
		if size.files > maxFilesPerPackage {
			violations = append(violations, fmt.Sprintf(
				"%s: %d files exceeds the ceiling of %d — split the package, do not raise the ceiling",
				dir, size.files, maxFilesPerPackage))
		}
	}
	sort.Strings(violations)

	if len(violations) > 0 {
		t.Errorf("package size budget exceeded:\n  %s", strings.Join(violations, "\n  "))
	}
}

// TestEveryPackageIsPinned is the other half of the size budget: a package with
// no pin is measured against nothing, so it fails here rather than silently
// escaping every ceiling.
func TestEveryPackageIsPinned(t *testing.T) {
	for _, dir := range packageDirs(t) {
		if _, ok := structuralPins[dir]; !ok {
			t.Errorf("package %s has no entry in structuralPins; add one (loc, exported, why) in this PR", dir)
		}
	}
	for dir := range structuralPins {
		if _, err := fs.Stat(repoFS, dir); err != nil {
			t.Errorf("structuralPins pins %s, which no longer exists; remove the stale entry", dir)
		}
	}
}

// TestCountGoFileDetectsGeneratedCode exercises marker detection and line
// counting directly: it is the unit that proves generated code is excluded
// from the budget rather than quietly inflating it.
func TestCountGoFileDetectsGeneratedCode(t *testing.T) {
	tests := []struct {
		name          string
		content       string
		wantGenerated bool
		wantLOC       int
	}{
		{
			name:          "hand-written file is counted",
			content:       "package x\n\nfunc f() {}\n",
			wantGenerated: false,
			wantLOC:       3,
		},
		{
			name:          "canonical generated marker is detected",
			content:       "// Code generated by stringer. DO NOT EDIT.\npackage x\n",
			wantGenerated: true,
			wantLOC:       2,
		},
		{
			name:          "marker after a build constraint is still detected",
			content:       "//go:build ignore\n\n// Code generated by mockgen. DO NOT EDIT.\npackage m\n",
			wantGenerated: true,
			wantLOC:       4,
		},
		{
			name:          "prose that merely mentions generated code is not a marker",
			content:       "package x\n\n// this is not Code generated by anything, DO NOT EDIT it\n",
			wantGenerated: false,
			wantLOC:       3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fsys := fstest.MapFS{"f.go": &fstest.MapFile{Data: []byte(tt.content)}}
			generated, loc := countGoFile(t, fsys, "f.go")
			if generated != tt.wantGenerated {
				t.Errorf("generated = %v, want %v", generated, tt.wantGenerated)
			}
			if loc != tt.wantLOC {
				t.Errorf("loc = %d, want %d", loc, tt.wantLOC)
			}
		})
	}
}
