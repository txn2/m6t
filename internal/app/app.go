// Package app holds the Wails binding layer: the object the frontend calls
// into over the Wails bridge, and the window options main hands to the Wails
// runtime. It is the composition leaf of the Go side — the backend services
// added in later issues are composed BY this package and must never import it.
package app

import (
	"context"
	"embed"
	"fmt"
	"os"
	"sync/atomic"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"github.com/txn2/m6t/internal/buildinfo"
	"github.com/txn2/m6t/internal/kubeexec"
	"github.com/txn2/m6t/internal/kubewatch"
	"github.com/txn2/m6t/internal/project"
	"github.com/txn2/m6t/internal/pty"
	"github.com/txn2/m6t/internal/session"
	"github.com/txn2/m6t/internal/stream"
	"github.com/txn2/m6t/internal/watch"
)

// Window geometry. m6t is a single-window app: the three-pane project
// workbench (tree / editor / cluster panel, DESIGN.md §5) needs room, and the
// minimums are the point below which those panes stop being usable.
const (
	windowTitle     = "m6t"
	windowWidth     = 1280
	windowHeight    = 800
	windowMinWidth  = 960
	windowMinHeight = 640
)

// windowBackground matches the frontend shell so the window does not flash
// white before the first paint.
var windowBackground = &options.RGBA{R: 22, G: 24, B: 29, A: 1}

// App is the object bound to the frontend. Wails exports every exported method
// to TypeScript, so this type's exported surface IS the backend's public API —
// keep it to what the UI actually calls, and keep the wiring (window options,
// asset server) out of it.
type App struct {
	info buildinfo.Info

	// terminals owns the PTY sessions behind the embedded terminal. It is one
	// handle rather than loose state because the app composes services, it
	// does not implement them: everything the terminal does lives in
	// internal/pty and is reached through here.
	terminals *pty.Manager

	// streams is the loopback WebSocket transport (DESIGN.md §3.3). Terminal
	// I/O does not cross the Wails bridge — the bridge carries only the
	// endpoint the frontend needs to open a socket to it.
	streams *stream.Server

	// projects is the project registry (DESIGN.md §4): the persistent list of
	// manifest repositories and their per-project settings. It is the app's
	// organizing unit — a project is what a tab, a working directory and a kube
	// binding all hang off.
	projects *project.Registry

	// sessions is the workspace session (#58): what the window was showing when
	// it was last closed. It is a second file in the same configuration
	// directory as the registry and a service of its own, because what it holds
	// is scratch — a session that will not parse is replaced by defaults, which
	// is the opposite of what projects.yaml does with the same failure.
	sessions *session.Store

	// kube runs kubectl for the bound project (DESIGN.md §3.2). It holds no
	// binding of its own: every call is handed the context and namespace the
	// registry resolved for the path being acted on, and refuses if either is
	// missing, which is what makes "m6t never targets an implicit cluster" a
	// property of the code rather than of the caller's discipline.
	kube *kubeexec.Service

	// watches is the live cluster health service (#12, DESIGN.md §3.2): the
	// read-only client-go watches behind the project panel's object list. It is
	// a second Kubernetes handle beside kube rather than part of it, and that
	// separation is the point — internal/kubewatch cannot mutate a cluster by
	// construction, so nothing reachable through this field can bypass the
	// confirm gate the mutation path goes through (DESIGN.md §6.1).
	watches *kubewatch.Service

	// trees watches every registered project's worktree (DESIGN.md §3.2) and
	// backs the tree UI's lazy listing and CRUD (tree.go). Every project is
	// an open tab from the moment it is registered, so a watcher's lifetime
	// tracks AddProject/RemoveProject and application startup.
	trees *watch.Service

	// window holds the Wails runtime context, published by OnStartup. It is what
	// native dialogs are addressed to — a directory picker has to be owned by a
	// window — and it is unset until OnStartup runs, which
	// ChooseProjectDirectory reports rather than dereferences.
	//
	// It is atomic because the two sides run on different goroutines: Wails
	// calls OnStartup on its own, and every bound method the frontend invokes
	// arrives on another. A plain field would be a data race whose safety
	// depended on undocumented ordering inside Wails.
	window atomic.Pointer[context.Context]
}

// newApp builds the binding. It is unexported because Options is the only
// supported way to construct the application: an App that is not bound into
// the window options is unreachable from the frontend.
func newApp() *App {
	terminals := pty.New()
	streams := stream.New(terminalBridge{terminals: terminals})

	// A registry with no path reports the failure on every call rather than
	// taking the window down at construction: an app that cannot find the OS
	// config directory can still run terminals, and a project list showing an
	// error is a better answer than no window at all. The session store is
	// handed the same directory rather than resolving one of its own — there is
	// one configuration directory, and two answers to where it is would be one
	// too many.
	configDir, err := project.ConfigDir()
	if err != nil {
		configDir = ""
	}

	projects := project.New(configDir)
	watches := kubewatch.New(
		manifestBridge{projects: projects}, kubewatch.Connect, healthBridge{streams: streams})

	return &App{
		info:      buildinfo.Get(),
		terminals: terminals,
		streams:   streams,
		projects:  projects,
		kube:      kubeexec.New(),
		sessions:  session.New(configDir),
		watches:   watches,

		// M6T_FS_POLL selects the polling fallback (DESIGN.md §3.2). The
		// per-project settings UI that arrived with #10 covers the kube
		// binding and nothing else, so a global override still unblocks a
		// network mount until the watcher has a control of its own.
		trees: watch.New(
			watchBridge{streams: streams, watches: watches},
			watch.Options{Poll: os.Getenv("M6T_FS_POLL") != ""}),
	}
}

// Version reports the build identity to the frontend, which shows it in the
// window's about line.
func (a *App) Version() buildinfo.Info {
	return a.info
}

// OpenTerminal starts a PTY session for a terminal tab at cwd, sized to the
// pane that will show it, and returns the identifier the frontend opens the
// session's stream socket with (PROTOCOL.md §4).
//
// Creating a session is the one terminal operation that belongs on the Wails
// bridge: it is a request with an answer and no throughput. Everything the tab
// does afterwards — keystrokes, resize, close — is a frame on the socket, which
// is what keeps the character stream off the bridge (DESIGN.md §3.3).
//
// No argv crosses the bridge. A tab is the user's login shell, and the "Claude
// Code" action is the frontend typing `claude` into a fresh one — which is also
// what leaves a usable shell behind when claude exits, instead of a dead tab.
// The size is passed here rather than left to the first resize frame so the
// shell's first prompt is drawn at the pane's real width.
func (a *App) OpenTerminal(cwd string, cols, rows uint16) (string, error) {
	id, err := a.terminals.Create(terminalOptions(cwd, cols, rows))
	if err != nil {
		return "", fmt.Errorf("opening terminal in %s: %w", cwd, err)
	}
	return string(id), nil
}

// StreamEndpoint reports the loopback port and per-launch token the frontend
// needs to open its stream sockets (DESIGN.md §3.3).
//
// This is the only path by which the token leaves the backend, and the reason
// nothing in the stream server logs: the credential crosses the bridge to the
// webview that needs it and goes nowhere else.
func (a *App) StreamEndpoint() (stream.Endpoint, error) {
	endpoint, err := a.streams.Endpoint()
	if err != nil {
		return stream.Endpoint{}, fmt.Errorf("stream endpoint: %w", err)
	}
	return endpoint, nil
}

// Options assembles the Wails application options around a freshly bound App.
// It lives here rather than in main so the window contract — single window,
// bound methods, embedded assets — is covered by tests rather than asserted in
// a comment.
func Options(assets embed.FS) *options.App {
	application := newApp()

	return &options.App{
		Title:            windowTitle,
		Width:            windowWidth,
		Height:           windowHeight,
		MinWidth:         windowMinWidth,
		MinHeight:        windowMinHeight,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: windowBackground,
		Bind:             []any{application},

		// The stream listener has to be up before the frontend asks for its
		// endpoint. A bind failure is not fatal to the window — the app still
		// runs, without terminals — and it is not logged here because the
		// server keeps it and StreamEndpoint reports it to the frontend, which
		// is where a user can actually see it.
		OnStartup: func(ctx context.Context) {
			// Published before the listener starts: the frontend cannot call a
			// bound method until the webview loads, and this is the only
			// assignment, so a reader either sees no window or sees this one.
			application.window.Store(&ctx)
			_ = application.streams.Start()
			startRegisteredWatchers(application.projects, application.trees)
		},

		// PTYs are backend-owned and outlive every window in the app, so the
		// only thing that ends them is the app ending. Without this hook,
		// quitting m6t would leave the user's shells — and whatever they were
		// running — orphaned behind it.
		//
		// Sockets close before sessions: a connection whose session is being
		// killed underneath it would otherwise report an exit nobody is left to
		// receive.
		OnShutdown: func(context.Context) {
			// The cluster watches go first: they are the only shutdown here
			// that reaches off the machine, and a watch connection the API
			// server has to age out itself is the one thing on this list that
			// outlives the process if it is not waited for.
			application.watches.Shutdown()
			application.streams.Shutdown()
			application.terminals.Shutdown()
			application.trees.Shutdown()
		},
	}
}
