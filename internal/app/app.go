// Package app holds the Wails binding layer: the object the frontend calls
// into over the Wails bridge, and the window options main hands to the Wails
// runtime. It is the composition leaf of the Go side — the backend services
// added in later issues are composed BY this package and must never import it.
package app

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"github.com/txn2/m6t/internal/buildinfo"
	"github.com/txn2/m6t/internal/pty"
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
}

// newApp builds the binding. It is unexported because Options is the only
// supported way to construct the application: an App that is not bound into
// the window options is unreachable from the frontend.
func newApp() *App {
	return &App{info: buildinfo.Get(), terminals: pty.New()}
}

// Version reports the build identity to the frontend, which shows it in the
// window's about line.
func (a *App) Version() buildinfo.Info {
	return a.info
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

		// PTYs are backend-owned and outlive every window in the app, so the
		// only thing that ends them is the app ending. Without this hook,
		// quitting m6t would leave the user's shells — and whatever they were
		// running — orphaned behind it.
		OnShutdown: func(context.Context) {
			application.terminals.Shutdown()
		},
	}
}
