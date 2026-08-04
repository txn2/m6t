package app

import (
	"embed"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/project"
)

// testApp builds the binding over a registry in a fresh temp directory.
func testApp(t *testing.T) *App {
	t.Helper()
	return &App{projects: project.New(t.TempDir())}
}

// repoDir creates a directory the registry will accept as a worktree.
func repoDir(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o750); err != nil {
		t.Fatalf("creating a fake repository: %v", err)
	}
	return dir
}

func TestAddProjectAndProjectsRoundTripThroughTheBinding(t *testing.T) {
	a := testApp(t)
	dir := repoDir(t, "infra")

	added, err := a.AddProject(dir)
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if added.Name != "infra" {
		t.Errorf("name = %q, want infra", added.Name)
	}

	listed, err := a.Projects()
	if err != nil {
		t.Fatalf("Projects: %v", err)
	}
	if len(listed) != 1 || listed[0].Name != "infra" {
		t.Errorf("Projects = %+v, want the project just added", listed)
	}
}

// The bindings are delegation with an error wrap, and the thing a wrap gets
// wrong is losing the sentinel the UI needs to tell "not registered" from "the
// config is broken".
func TestProjectBindingsPreserveTheRegistrySentinels(t *testing.T) {
	a := testApp(t)

	tests := map[string]struct {
		call func() error
		want error
	}{
		"RemoveProject": {
			call: func() error { return a.RemoveProject("ghost") },
			want: project.ErrNotFound,
		},
		"UpdateProject": {
			call: func() error {
				_, err := a.UpdateProject("ghost", project.Settings{})
				return err
			},
			want: project.ErrNotFound,
		},
		"AddProject": {
			call: func() error {
				_, err := a.AddProject(t.TempDir())
				return err
			},
			want: project.ErrNotRepository,
		},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			err := tt.call()
			if err == nil {
				t.Fatalf("%s succeeded, want an error", name)
			}
			if !errors.Is(err, tt.want) {
				t.Errorf("%s error = %v, want it to wrap %v", name, err, tt.want)
			}
		})
	}
}

// A wrapped error still has to name what the user acted on. "adding project"
// with no path is a message that sends someone to the logs.
func TestProjectBindingErrorsNameTheirSubject(t *testing.T) {
	a := testApp(t)

	if err := a.RemoveProject("ghost"); err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Errorf("RemoveProject error = %v, want it to name the project", err)
	}
	plain := t.TempDir()
	if _, err := a.AddProject(plain); err == nil || !strings.Contains(err.Error(), plain) {
		t.Errorf("AddProject error = %v, want it to name the path", err)
	}
}

func TestUpdateProjectPersistsSettings(t *testing.T) {
	a := testApp(t)
	if _, err := a.AddProject(repoDir(t, "infra")); err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	want := project.Settings{Kube: project.Kube{Context: "prod-us-west", Protected: true}}
	updated, err := a.UpdateProject("infra", want)
	if err != nil {
		t.Fatalf("UpdateProject: %v", err)
	}
	if updated.Kube != want.Kube {
		t.Errorf("returned kube = %+v, want %+v", updated.Kube, want.Kube)
	}

	listed, err := a.Projects()
	if err != nil {
		t.Fatalf("Projects: %v", err)
	}
	if len(listed) != 1 || listed[0].Kube != want.Kube {
		t.Errorf("Projects after update = %+v, want the new binding", listed)
	}
}

func TestRemoveProjectLeavesTheWorkingTree(t *testing.T) {
	a := testApp(t)
	dir := repoDir(t, "infra")
	if _, err := a.AddProject(dir); err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	if err := a.RemoveProject("infra"); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		t.Errorf("RemoveProject touched the working tree: %v", err)
	}
}

// A registry that could not find a config directory reports it on every call
// rather than looking empty — an app that silently forgot every project is the
// failure this guards.
func TestProjectsReportsAnUnusableConfigLocation(t *testing.T) {
	a := &App{projects: project.New("")}

	if _, err := a.Projects(); err == nil {
		t.Error("Projects with no config path succeeded, want an error")
	}
}

// The directory picker cannot open before the Wails runtime has handed the app
// its context. It reports that rather than dereferencing a nil one and taking
// the window down with it.
func TestChooseProjectDirectoryBeforeStartupIsReported(t *testing.T) {
	a := testApp(t)

	dir, err := a.ChooseProjectDirectory()
	if !errors.Is(err, errNoWindow) {
		t.Errorf("ChooseProjectDirectory before startup = %q, %v, want errNoWindow", dir, err)
	}
}

// The other half, and the half that matters: OnStartup must actually publish
// the context to the bound object.
//
// Testing only the guard above is what let a version ship where the field was
// declared, documented and never assigned — every dialog reported "the
// application window is not ready" and the suite was green. This asserts the
// wiring through Options, which is the only supported way the app is built, so
// a hook that stops publishing fails here rather than in a screenshot.
func TestOptionsStartupPublishesTheWindowContext(t *testing.T) {
	options := Options(embed.FS{})

	bound, ok := options.Bind[0].(*App)
	if !ok {
		t.Fatalf("Bind[0] is %T, want *App", options.Bind[0])
	}
	if bound.window.Load() != nil {
		t.Fatal("the window context is set before startup, want it unset")
	}

	options.OnStartup(t.Context())

	published := bound.window.Load()
	if published == nil {
		t.Fatal("OnStartup did not publish the window context; every native dialog would report errNoWindow")
	}
	if *published != t.Context() {
		t.Error("OnStartup published a different context than the one it was given")
	}

	// The test stops here deliberately. Calling ChooseProjectDirectory now would
	// reach the Wails runtime, which terminates the process when handed anything
	// other than a real lifecycle context — so the dialog itself is only
	// exercisable by a human with a window, and the guard above is what stands
	// between a missing context and that outcome.
}
