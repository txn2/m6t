package app

import (
	"context"
	"embed"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
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

// OpenTerminal is the frontend's only way to get a session, so the identifier
// it hands back has to be one the stream server can attach to — an id the
// manager does not know is a terminal tab that opens onto a 404.
func TestOpenTerminalReturnsAnAttachableSession(t *testing.T) {
	application := newApp()
	t.Cleanup(application.terminals.Shutdown)

	id, err := application.OpenTerminal(t.TempDir(), 100, 40)
	if err != nil {
		t.Fatalf("OpenTerminal: %v", err)
	}
	if id == "" {
		t.Fatal("OpenTerminal returned an empty session id")
	}

	attachment, err := application.terminals.Attach(pty.SessionID(id))
	if err != nil {
		t.Fatalf("attaching to the session OpenTerminal returned: %v", err)
	}
	attachment.Detach()

	// Two tabs are two shells. An id reused across calls would put both tabs on
	// one PTY, with each one's keystrokes arriving in the other.
	second, err := application.OpenTerminal(t.TempDir(), 100, 40)
	if err != nil {
		t.Fatalf("OpenTerminal (second): %v", err)
	}
	if second == id {
		t.Errorf("both calls returned session id %q; each tab needs its own", id)
	}
}

// A tab whose directory is gone must fail at the call, with the directory named
// — the frontend shows this string to the user, and "opening terminal" alone
// does not say which one.
func TestOpenTerminalFailsWhenTheDirectoryDoesNotExist(t *testing.T) {
	application := newApp()
	t.Cleanup(application.terminals.Shutdown)

	missing := filepath.Join(t.TempDir(), "no-such-directory")

	id, err := application.OpenTerminal(missing, 100, 40)
	if err == nil {
		t.Fatalf("OpenTerminal in a missing directory returned id %q and no error", id)
	}
	if id != "" {
		t.Errorf("OpenTerminal returned id %q alongside an error, want the empty id", id)
	}
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("error %q does not name the directory %q", err, missing)
	}
}

// The argument-to-field mapping, pinned directly. A transposed cols/rows draws
// every prompt at the wrong width, and a dropped Cwd silently starts the tab in
// the application's own directory — both are wrong quietly rather than loudly.
func TestTerminalOptionsMapEachArgumentToItsField(t *testing.T) {
	got := terminalOptions("/projects/infra-prod", 120, 40)

	if got.Cwd != "/projects/infra-prod" {
		t.Errorf("Cwd = %q, want %q", got.Cwd, "/projects/infra-prod")
	}
	if got.Cols != 120 {
		t.Errorf("Cols = %d, want 120", got.Cols)
	}
	if got.Rows != 40 {
		t.Errorf("Rows = %d, want 40", got.Rows)
	}
	if got.Command != nil {
		t.Errorf("Command = %v, want nil: a tab runs the user's login shell and no argv crosses the bridge", got.Command)
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
