// Package app holds the Wails binding layer: the object the frontend calls
// into over the Wails bridge, and the window options main hands to the Wails
// runtime. It is the composition leaf of the Go side — the backend services
// added in later issues are composed BY this package and must never import it.
package app

import (
	"context"
	"embed"
	"fmt"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"github.com/txn2/m6t/internal/buildinfo"
	"github.com/txn2/m6t/internal/pty"
	"github.com/txn2/m6t/internal/stream"
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
}

// newApp builds the binding. It is unexported because Options is the only
// supported way to construct the application: an App that is not bound into
// the window options is unreachable from the frontend.
func newApp() *App {
	terminals := pty.New()
	return &App{
		info:      buildinfo.Get(),
		terminals: terminals,
		streams:   stream.New(terminalBridge{terminals: terminals}),
	}
}

// Version reports the build identity to the frontend, which shows it in the
// window's about line.
func (a *App) Version() buildinfo.Info {
	return a.info
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
		OnStartup: func(context.Context) {
			_ = application.streams.Start()
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
			application.streams.Shutdown()
			application.terminals.Shutdown()
		},
	}
}
