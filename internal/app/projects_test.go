package app

import (
	"embed"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/dynamic"

	"github.com/txn2/m6t/internal/kubewatch"
	"github.com/txn2/m6t/internal/project"
	"github.com/txn2/m6t/internal/watch"
)

// testApp builds the binding over a registry in a fresh temp directory, with
// the file watcher and the cluster watch service wired so that
// AddProject/RemoveProject's lifecycle calls are exercised rather than
// nil-panicking.
func testApp(t *testing.T) *App {
	t.Helper()

	projects := project.New(t.TempDir())
	a := &App{
		projects: projects,
		trees:    watch.New(discardEvents{}, watch.Options{}),
		watches:  testWatches(t, projects),
	}
	t.Cleanup(a.trees.Shutdown)
	return a
}

// testWatches builds the cluster watch service the binding layer's tests run
// with, stopped on cleanup.
func testWatches(t *testing.T, projects *project.Registry) *kubewatch.Service {
	t.Helper()

	watches := kubewatch.New(
		manifestBridge{projects: projects}, unreachableCluster, discardEvents{})
	t.Cleanup(watches.Shutdown)
	return watches
}

// unreachableCluster is the Connector these tests run with. Nothing in the
// binding layer's own tests should reach a cluster, and a connector that
// refuses is how that is stated rather than assumed: a test that started a
// watch by accident fails here instead of hanging on a dial.
func unreachableCluster(string) (dynamic.Interface, meta.RESTMapper, error) {
	return nil, nil, errors.New("no cluster in the binding layer's tests")
}

// discardEvents is a watch.Events that does nothing — the binding-layer
// tests care about the registry and the watcher's lifecycle, not what it
// publishes; internal/stream and internal/watch each cover that on their
// own side of the seam.
type discardEvents struct{}

func (discardEvents) PublishTreeChanged(string, []string) {}
func (discardEvents) PublishHealthChanged(string)         {}

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

	added, err := a.AddProject(dir, "")
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
				_, err := a.AddProject(t.TempDir(), "")
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
	if _, err := a.AddProject(plain, ""); err == nil || !strings.Contains(err.Error(), plain) {
		t.Errorf("AddProject error = %v, want it to name the path", err)
	}
}

func TestUpdateProjectPersistsSettings(t *testing.T) {
	a := testApp(t)
	if _, err := a.AddProject(repoDir(t, "infra"), ""); err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	want := project.Settings{Kube: project.Kube{Context: "prod-us-west", Protected: true}}
	updated, err := a.UpdateProject("infra", want)
	if err != nil {
		t.Fatalf("UpdateProject: %v", err)
	}
	if !reflect.DeepEqual(updated.Kube, want.Kube) {
		t.Errorf("returned kube = %+v, want %+v", updated.Kube, want.Kube)
	}

	listed, err := a.Projects()
	if err != nil {
		t.Fatalf("Projects: %v", err)
	}
	if len(listed) != 1 || !reflect.DeepEqual(listed[0].Kube, want.Kube) {
		t.Errorf("Projects after update = %+v, want the new binding", listed)
	}
}

// The add flow collects a label because the directory name is a bad identity —
// almost every manifest repository is checked out as "k8s" (#41).
func TestAddProjectCarriesTheLabelItWasGiven(t *testing.T) {
	a := testApp(t)

	added, err := a.AddProject(repoDir(t, "k8s"), "Production infra")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if added.DisplayName != "Production infra" {
		t.Errorf("display name = %q, want the label the flow collected", added.DisplayName)
	}
	if added.Name != "k8s" {
		t.Errorf("name = %q, want the registry key still derived from the directory", added.Name)
	}
}

func TestReorderProjectsRewritesTheStripOrder(t *testing.T) {
	a := testApp(t)
	for _, name := range []string{"alpha", "beta"} {
		if _, err := a.AddProject(repoDir(t, name), ""); err != nil {
			t.Fatalf("AddProject %s: %v", name, err)
		}
	}

	ordered, err := a.ReorderProjects([]string{"beta", "alpha"})
	if err != nil {
		t.Fatalf("ReorderProjects: %v", err)
	}
	if len(ordered) != 2 || ordered[0].Name != "beta" || ordered[1].Name != "alpha" {
		t.Errorf("returned order = %+v, want [beta alpha]", ordered)
	}

	// The returned list is what the strip renders, so it has to agree with what
	// the next read would give.
	listed, err := a.Projects()
	if err != nil {
		t.Fatalf("Projects: %v", err)
	}
	if len(listed) != 2 || listed[0].Name != "beta" {
		t.Errorf("Projects after reorder = %+v, want [beta alpha]", listed)
	}
}

func TestReorderProjectsReportsAnOrderTheRegistryRejects(t *testing.T) {
	a := testApp(t)
	if _, err := a.AddProject(repoDir(t, "alpha"), ""); err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	if _, err := a.ReorderProjects([]string{"ghost"}); !errors.Is(err, project.ErrNotFound) {
		t.Errorf("ReorderProjects of an unregistered name = %v, want ErrNotFound", err)
	}
}

func TestRemoveProjectLeavesTheWorkingTree(t *testing.T) {
	a := testApp(t)
	dir := repoDir(t, "infra")
	if _, err := a.AddProject(dir, ""); err != nil {
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
