package app

import (
	"context"
	"embed"
	"errors"
	"runtime"
	"testing"

	"github.com/txn2/m6t/internal/buildinfo"
	"github.com/txn2/m6t/internal/pty"
)

//go:embed testdata
var testAssets embed.FS

func TestVersionReportsTheStampedBuildIdentity(t *testing.T) {
	got := newApp().Version()
	if want := buildinfo.Get(); got != want {
		t.Errorf("Version() = %+v, want %+v", got, want)
	}
}

// The window contract is what makes m6t a single-window workbench rather than
// a browser tab: a titled window, resizable but not below the point where the
// three panes stop working.
func TestOptionsDeclareTheSingleWindowContract(t *testing.T) {
	opts := Options(testAssets)

	if opts.Title != "m6t" {
		t.Errorf("Title = %q, want %q", opts.Title, "m6t")
	}
	if opts.Width != windowWidth || opts.Height != windowHeight {
		t.Errorf("size = %dx%d, want %dx%d", opts.Width, opts.Height, windowWidth, windowHeight)
	}
	if opts.MinWidth != windowMinWidth || opts.MinHeight != windowMinHeight {
		t.Errorf("minimum size = %dx%d, want %dx%d",
			opts.MinWidth, opts.MinHeight, windowMinWidth, windowMinHeight)
	}
	if opts.MinWidth > opts.Width || opts.MinHeight > opts.Height {
		t.Errorf("minimum size %dx%d exceeds the default size %dx%d",
			opts.MinWidth, opts.MinHeight, opts.Width, opts.Height)
	}
	if opts.BackgroundColour == nil || *opts.BackgroundColour != *windowBackground {
		t.Errorf("BackgroundColour = %v, want %v", opts.BackgroundColour, windowBackground)
	}
}

func TestOptionsServeTheEmbeddedAssets(t *testing.T) {
	opts := Options(testAssets)

	if opts.AssetServer == nil {
		t.Fatal("AssetServer is nil; the frontend would not be served")
	}
	assets, ok := opts.AssetServer.Assets.(embed.FS)
	if !ok {
		t.Fatalf("AssetServer.Assets is %T, want embed.FS", opts.AssetServer.Assets)
	}
	if _, err := assets.ReadFile("testdata/marker.txt"); err != nil {
		t.Errorf("embedded assets do not contain the file that was passed in: %v", err)
	}
}

// Wails exports every exported method of a bound object to TypeScript. Binding
// anything beyond the App — or growing the App's exported surface — silently
// widens the backend's public API, so the binding list is pinned here.
func TestOptionsBindOnlyTheApp(t *testing.T) {
	opts := Options(testAssets)

	if len(opts.Bind) != 1 {
		t.Fatalf("Bind has %d entries, want exactly the App", len(opts.Bind))
	}
	bound, ok := opts.Bind[0].(*App)
	if !ok {
		t.Fatalf("Bind[0] is %T, want *App", opts.Bind[0])
	}
	if bound.Version() != buildinfo.Get() {
		t.Errorf("the bound App reports %+v, want %+v", bound.Version(), buildinfo.Get())
	}
}

// PTYs are backend-owned and outlive every window, so the app quitting is the
// only thing that ends them. Without the shutdown hook, closing m6t would
// orphan the user's shells and whatever they were running.
func TestShutdownTerminatesEveryTerminalSession(t *testing.T) {
	opts := Options(testAssets)

	application, ok := opts.Bind[0].(*App)
	if !ok {
		t.Fatalf("Bind[0] is %T, want *App", opts.Bind[0])
	}
	if opts.OnShutdown == nil {
		t.Fatal("OnShutdown is nil; quitting the app would leave its PTY sessions running")
	}

	id, err := application.terminals.Create(pty.Options{Command: longRunningCommand()})
	if err != nil {
		t.Fatalf("creating a terminal session: %v", err)
	}

	opts.OnShutdown(context.Background())

	if _, err := application.terminals.Attach(id); !errors.Is(err, pty.ErrNoSuchSession) {
		t.Errorf("session %s survived shutdown: Attach error = %v, want ErrNoSuchSession", id, err)
	}
}

// longRunningCommand returns an argv that stays alive until it is killed.
func longRunningCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe", "/c", "ping -n 61 127.0.0.1 >NUL"}
	}
	return []string{"/bin/sh", "-c", "sleep 60"}
}

func TestEachCallBuildsItsOwnBinding(t *testing.T) {
	first := Options(testAssets).Bind[0]
	second := Options(testAssets).Bind[0]
	if first == second {
		t.Error("Options returned a shared App instance; each window must own its binding")
	}
}
