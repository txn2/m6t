package main_test

import (
	"go/ast"
	"testing"
)

// The god-object gate. The package-size budget is gameable in exactly the
// direction that matters here: moving code out of app.go into sibling files
// shrinks the line count while the App struct keeps every field and every
// method. This gate caps the struct itself.
//
// App is m6t's coordinator. Wails binds it to the frontend and it composes the
// backend services (git, pty, kube, helm; DESIGN.md §3.2) as they land, so it
// is the one type in the tree that everything else will be reachable through —
// which is precisely why it needs a ceiling from day one rather than after it
// has grown into a decomposition project.
//
// Run: go test -run TestAppGodObjectBudget .
const (
	// maxAppFields caps fields on the App struct. Pinned at today's actual
	// with zero slack.
	//
	// This ceiling WILL need raising as backend services land, and that is the
	// design: each service arrives as one composed handle, in a PR that says so
	// on this line. What it stops is the accumulation nobody decided on — six
	// loose fields where one owner struct belonged. If raising it by more than
	// one per service, the question to answer in review is why the service is
	// not one handle.
	//
	// 1 -> 2 in #2: the PTY service arrives as a single *pty.Manager handle.
	// Every terminal behavior — create, write, resize, kill, scrollback —
	// lives in internal/pty and is reached through that one field, so this is
	// the one-handle-per-service case the paragraph above describes, not
	// state accumulating on the coordinator.
	//
	// 2 -> 3 in #3: the loopback stream server arrives as a single
	// *stream.Server handle. It is a second service rather than terminal state
	// spread across the App — the port, the token, the live connections and the
	// event subscribers all live behind that field in internal/stream, and the
	// App holds it only to start it, stop it, and report its endpoint.
	//
	// 3 -> 5 in #5. The project registry arrives as a single *project.Registry
	// handle: the one-handle-per-service case again — the registry owns its
	// file, its locking and its validation, and the App holds it only to
	// delegate. Five bound methods arrived with it and the handle count moved by
	// one, which is the relationship this ceiling exists to keep true.
	//
	// The second field is the Wails runtime context, captured in OnStartup. It
	// is not service state: native dialogs have to be addressed to a window, and
	// this is the only handle on one. It is a field rather than a parameter
	// because Wails hands it over at startup and the bound methods the frontend
	// calls take only their own arguments.
	//
	// 5 -> 6 in #6. The file-tree watcher arrives as a single *watch.Service
	// handle: the one-handle-per-service case a fourth time — every open
	// project's fsnotify/poll watcher, its coalescing and its lifecycle live in
	// internal/watch, and the App holds the handle only to start, stop and wire
	// it to the stream server. The lookup and startup-fanout helpers this
	// service needed (projectPath, startRegisteredWatchers) are free functions
	// over the registry and service handles the App already has, not App
	// methods — spending fields is the described pattern, spending the method
	// ceiling on internal wiring is not.
	maxAppFields = 6

	// maxAppMethods caps methods with an App receiver, counting value and
	// pointer receivers alike. Pinned at today's actual with zero slack.
	//
	// Every exported method here is also Wails-bound API — it crosses the
	// bridge into TypeScript — so this ceiling doubles as the budget on the
	// backend's public surface. Behavior belongs on the service that owns it,
	// reached through a handle, not on the coordinator.
	//
	// 1 -> 2 in #3: StreamEndpoint. The whole design of the transport is that
	// terminal I/O does NOT cross this bridge (DESIGN.md §3.3), so the one
	// method the stream server needs here is the one that tells the frontend
	// where to open a socket and with what token. Every subsequent terminal
	// operation — write, resize, close — is a WebSocket frame and adds nothing
	// to this number. A future PR that adds a per-operation binding is not
	// raising a ceiling, it is bypassing the transport.
	//
	// 2 -> 3 in #4: OpenTerminal. The paragraph above is the test this had to
	// pass, and creating a session is the one terminal operation that is not a
	// per-operation binding — it is a request with an answer and no throughput,
	// and it has to happen BEFORE there is a socket to ask on. Write, resize and
	// close all stayed on the socket, which is what that paragraph was
	// protecting. This is the last terminal method: #5 gives a tab a project's
	// cwd, and a cwd is an argument to this one, not a new binding.
	//
	// 3 -> 8 in #5, and the promise above held: no terminal method was added.
	// A project's cwd is an argument to OpenTerminal exactly as predicted. The
	// five new methods are the project registry's surface — Projects,
	// ChooseProjectDirectory, AddProject, RemoveProject, UpdateProject — and
	// they are bound rather than pushed onto the transport because each is a
	// request with an answer and no throughput, which is the same test
	// OpenTerminal had to pass.
	//
	// This is the largest single raise this ceiling will take, because it is a
	// whole service's surface landing at once rather than a method at a time.
	// The get-settings binding the issue asked for was deliberately NOT added:
	// Projects already returns every project's settings, so a reader would have
	// been a second way to fetch what the frontend holds.
	//
	// 8 -> 12 in #6. ListDirectory, CreateEntry, RenameEntry, DeleteEntry: the
	// file tree's whole surface, the same shape the project registry's five
	// methods took in #5 — a request with an answer and no throughput, once per
	// operation the tree UI drives directly. Watching itself adds nothing here:
	// a project's watcher starts and stops from AddProject/RemoveProject and
	// application startup, never from a binding of its own, which is what kept
	// this a four-method raise instead of a wider one.
	//
	// 12 -> 14 in #7. ReadFile, WriteFile: the editor's file content I/O
	// (DESIGN.md §5), the same request-with-an-answer-and-no-throughput shape
	// every binding on this list already takes — a file's bytes are not a
	// stream, so unlike terminal I/O they belong on the bridge rather than the
	// loopback socket. No new field came with them: both delegate through the
	// same *watch.Service handle ListDirectory already reaches, in
	// internal/app/files.go rather than tree.go, because file content and
	// directory shape are different enough concerns to read as separate files
	// even though they share one backing package (internal/watch, see
	// package_budget_test.go's #7 note for why).
	// 14 -> 15 in #8. GitStatus: the git service's whole bound surface, and
	// the first service to arrive without also taking a field. There is no
	// handle to hold because internal/git keeps nothing between calls — a
	// status is read from the repository each time one is asked for — so
	// maxAppFields stays at 6 while a fourth backend service lands.
	//
	// It is one method rather than several because the refresh trigger is not
	// a binding: the watcher #6 already runs publishes a `git` event
	// (PROTOCOL.md §5) and the frontend calls this again. A future PR adding
	// GitRefresh, or a binding per git subcommand, would be pushing work onto
	// the bridge that the transport is already carrying.
	//
	// 15 -> 23 in #9. The paragraph above forbids "a binding per git
	// subcommand" as a way of bypassing the transport, and that is worth
	// answering directly rather than around: the transport carries streams,
	// and none of these is one. Stage, unstage, commit, pull, push, checkout
	// and the two ref listings are each a request with an answer and no
	// throughput — the same test OpenTerminal and the registry's five methods
	// had to pass — so a socket frame per stage would be inventing a protocol
	// for a call that completes once and returns nothing. What that paragraph
	// was protecting against is a GitRefresh, and there still is not one: the
	// frontend re-reads through GitStatus after an operation, which is why
	// none of these eight returns a status of its own.
	//
	// This is the whole mutating half of a service landing at once, the same
	// shape as #5's 3 -> 8, and like #8 it takes no field: internal/git still
	// keeps nothing between calls, so maxAppFields stays at 6 while the
	// service doubles its surface. GitBranches and GitRemotes stayed two
	// methods rather than one GitRefs because the frontend degrades them
	// independently — a repository whose `git remote` fails should still fill
	// its branch dropdown — and one call returning both would make either
	// failure take out both lists.
	maxAppMethods = 23

	// appCoordinatorType is the struct these ceilings bound.
	appCoordinatorType = "App"

	// appPackageDir holds the coordinator.
	appPackageDir = "internal/app"
)

// TestAppGodObjectBudget fails when the coordinator gains fields or methods
// beyond the pinned ceilings. Unlike a line-count budget these numbers cannot
// be satisfied by shuffling code between files: they only come down through
// real decomposition — moving state and behavior onto the service that owns
// it.
func TestAppGodObjectBudget(t *testing.T) {
	fields, methods := countCoordinator(t)
	t.Logf("%s coordinator: %d fields, %d methods (ceilings %d / %d)",
		appCoordinatorType, fields, methods, maxAppFields, maxAppMethods)

	if fields > maxAppFields {
		t.Errorf("%s has %d fields, exceeding the ceiling of %d — group the new state into a service handle rather than holding it directly, or justify the raise on maxAppFields in this PR",
			appCoordinatorType, fields, maxAppFields)
	}
	if methods > maxAppMethods {
		t.Errorf("%s has %d methods, exceeding the ceiling of %d — move behavior onto the service that owns it (and remember every exported method here is also Wails-bound API), or justify the raise on maxAppMethods in this PR",
			appCoordinatorType, methods, maxAppMethods)
	}
}

// countCoordinator parses the coordinator's package and returns the struct's
// field count and the number of methods declared on it.
func countCoordinator(t *testing.T) (fields, methods int) {
	t.Helper()
	files := parsePackage(t, appPackageDir)

	found := false
	for _, file := range files {
		for _, decl := range file.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if name, ok := receiverTypeName(d); ok && name == appCoordinatorType {
					methods++
				}
			case *ast.GenDecl:
				if n, ok := structFieldCount(d, appCoordinatorType); ok {
					fields = n
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatalf("did not find `type %s struct` in %s — if the coordinator was renamed, retarget this gate rather than deleting it",
			appCoordinatorType, appPackageDir)
	}
	return fields, methods
}

// structFieldCount returns the field count of the named struct, counting each
// name in a grouped declaration (`a, b int` is two) and each embedded field as
// one. The bool is false for any declaration that is not that struct.
//
// Embedded fields count deliberately: embedding a struct to inherit its
// methods is a way of growing the coordinator without naming a field.
func structFieldCount(decl *ast.GenDecl, typeName string) (int, bool) {
	for _, spec := range decl.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok || ts.Name.Name != typeName {
			continue
		}
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			continue
		}
		count := 0
		for _, field := range st.Fields.List {
			if len(field.Names) == 0 {
				count++ // embedded
				continue
			}
			count += len(field.Names)
		}
		return count, true
	}
	return 0, false
}

// TestGodObjectMetricCountsGroupedAndEmbeddedFields pins the metric. A field
// counter that missed grouped or embedded declarations would let the
// coordinator grow while reporting a flat number — the failure mode that makes
// a ratchet worthless.
func TestGodObjectMetricCountsGroupedAndEmbeddedFields(t *testing.T) {
	const src = `package sample

type Embedded struct{}

type Target struct {
	a, b int
	c    string
	Embedded
}

type Other struct{ x, y, z int }

func (t *Target) PointerMethod() {}
func (t Target) ValueMethod()    {}
func (o *Other) NotCounted()     {}
func Free()                      {}
`
	file := parseSource(t, src)

	fields, found := 0, false
	methods := 0
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if name, ok := receiverTypeName(d); ok && name == "Target" {
				methods++
			}
		case *ast.GenDecl:
			if n, ok := structFieldCount(d, "Target"); ok {
				fields, found = n, true
			}
		}
	}

	if !found {
		t.Fatal("structFieldCount did not find the Target struct")
	}
	// a, b, c, and the embedded field.
	if want := 4; fields != want {
		t.Errorf("fields = %d, want %d (grouped names and embedded fields each count)", fields, want)
	}
	// Both receiver forms count; the other type's method and the free function do not.
	if want := 2; methods != want {
		t.Errorf("methods = %d, want %d (value and pointer receivers both count)", methods, want)
	}
}
