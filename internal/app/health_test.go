package app

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/kubewatch"
	"github.com/txn2/m6t/internal/project"
	"github.com/txn2/m6t/internal/stream"
)

// writeYAML writes a YAML file into a project's worktree, making its parents.
func writeYAML(t *testing.T, root, rel, body string) {
	t.Helper()

	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		t.Fatalf("MkdirAll %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
		t.Fatalf("WriteFile %s: %v", rel, err)
	}
}

// deploymentYAML is a manifest the indexer will index and nothing more.
func deploymentYAML(name string) string {
	return "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: " + name + "\n"
}

// declaredNames renders a Declared result as "name@file" lines.
func declaredNames(objects []kubewatch.Object) []string {
	out := make([]string, 0, len(objects))
	for _, o := range objects {
		out = append(out, o.Name+"@"+o.File)
	}
	slices.Sort(out)
	return out
}

// The scope rule is project.Kube.Resolve's, and this bridge is the only place
// it is applied to a manifest. The layout is the one folder overrides exist
// for: a `dev/` tree pointing at another cluster, and a `prod/api` tree at
// another namespace of the project's own.
func TestDeclaredKeepsOnlyTheObjectsBelongingToOneBinding(t *testing.T) {
	a, name := boundApp(t)
	root := projectRoot(t, a, name)

	writeYAML(t, root, "base.yaml", deploymentYAML("base"))
	writeYAML(t, root, "dev/app.yaml", deploymentYAML("dev-app"))
	writeYAML(t, root, "prod/app.yaml", deploymentYAML("prod-app"))
	writeYAML(t, root, "prod/api/app.yaml", deploymentYAML("api-app"))

	bridge := manifestBridge{projects: a.projects}

	tests := []struct {
		name      string
		target    string
		namespace string
		want      []string
	}{
		{
			name:      "the project default",
			target:    "prod-us-west",
			namespace: "default",
			// prod/ overrides only `protected`, so it inherits this binding and
			// belongs to it; prod/api overrides the namespace and does not.
			want: []string{"base@base.yaml", "prod-app@prod/app.yaml"},
		},
		{
			name:      "the dev override, which is another cluster",
			target:    "dev-cluster",
			namespace: "dev",
			want:      []string{"dev-app@dev/app.yaml"},
		},
		{
			name:      "the prod/api override, which is another namespace",
			target:    "prod-us-west",
			namespace: "api",
			want:      []string{"api-app@prod/api/app.yaml"},
		},
		{
			name:      "a binding nothing in the checkout resolves to",
			target:    "staging",
			namespace: "shop",
			want:      []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			objects, _, err := bridge.Declared(root, tt.target, tt.namespace)
			if err != nil {
				t.Fatalf("Declared: %v", err)
			}
			if got := declaredNames(objects); !slices.Equal(got, tt.want) {
				t.Errorf("Declared = %v, want %v", got, tt.want)
			}
		})
	}
}

// Between them the bindings must cover every declared object exactly once —
// nothing counted twice and nothing left out. A filter that used a prefix
// rather than the resolution rule would fail one half or the other.
func TestDeclaredPartitionsTheCheckoutAcrossBindings(t *testing.T) {
	a, name := boundApp(t)
	root := projectRoot(t, a, name)

	writeYAML(t, root, "base.yaml", deploymentYAML("base"))
	writeYAML(t, root, "dev/app.yaml", deploymentYAML("dev-app"))
	writeYAML(t, root, "prod/app.yaml", deploymentYAML("prod-app"))
	writeYAML(t, root, "prod/api/app.yaml", deploymentYAML("api-app"))

	bridge := manifestBridge{projects: a.projects}
	bindings := [][2]string{
		{"prod-us-west", "default"},
		{"dev-cluster", "dev"},
		{"prod-us-west", "api"},
	}

	covered := make([]string, 0, 4)
	for _, binding := range bindings {
		objects, _, err := bridge.Declared(root, binding[0], binding[1])
		if err != nil {
			t.Fatalf("Declared(%v): %v", binding, err)
		}
		covered = append(covered, declaredNames(objects)...)
	}
	slices.Sort(covered)

	want := []string{"api-app@prod/api/app.yaml", "base@base.yaml", "dev-app@dev/app.yaml", "prod-app@prod/app.yaml"}
	if !slices.Equal(covered, want) {
		t.Errorf("the bindings together cover %v, want %v", covered, want)
	}
}

// The indexer's notices reach the panel whichever binding is asking: a file
// that will not parse is a fact about the repository, and no binding owns it.
func TestDeclaredCarriesTheIndexerNotices(t *testing.T) {
	a, name := boundApp(t)
	root := projectRoot(t, a, name)

	writeYAML(t, root, "app.yaml", deploymentYAML("web"))
	writeYAML(t, root, "broken.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n\tname: tabs\n")

	_, notices, err := manifestBridge{projects: a.projects}.Declared(root, "prod-us-west", "default")
	if err != nil {
		t.Fatalf("Declared: %v", err)
	}
	if len(notices) != 1 || notices[0].File != "broken.yaml" {
		t.Fatalf("notices = %+v, want exactly one for broken.yaml", notices)
	}
	if notices[0].Reason == "" {
		t.Error("the notice carries no reason")
	}
}

// A session outlives the call that started it and is keyed on the checkout's
// path, so the bridge looks a project up the same way rather than by a name
// that can be edited while a watch is running.
func TestDeclaredReportsACheckoutTheRegistryDoesNotHave(t *testing.T) {
	a := testApp(t)

	_, _, err := manifestBridge{projects: a.projects}.Declared("/nowhere", "prod", "default")
	if !errors.Is(err, project.ErrNotFound) {
		t.Errorf("Declared for an unregistered checkout = %v, want ErrNotFound", err)
	}
}

func TestKubeHealthAimsAtTheSelectionsBinding(t *testing.T) {
	a, name := boundApp(t)
	root := projectRoot(t, a, name)
	writeYAML(t, root, "dev/app.yaml", deploymentYAML("dev-app"))

	// The connector these tests run with refuses, so the session settles on a
	// reported failure rather than a fabricated success. What is under test is
	// that a session was aimed and started at all.
	got, err := a.KubeHealth(name, "dev")
	if err != nil {
		t.Fatalf("KubeHealth: %v", err)
	}
	if got.Phase == "" {
		t.Error("KubeHealth returned no phase")
	}
}

// An unbound selection starts nothing. Read-only or not, connecting to
// whatever the kubeconfig would have picked is what DESIGN.md §4 forbids.
func TestKubeHealthIsIdleForAnUnboundSelection(t *testing.T) {
	a := testApp(t)
	added, err := a.AddProject(repoDir(t, "loose"), "")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	got, err := a.KubeHealth(added.Name, "")
	if err != nil {
		t.Fatalf("KubeHealth: %v", err)
	}
	if got.Phase != kubewatch.PhaseIdle {
		t.Errorf("phase = %q, want %q", got.Phase, kubewatch.PhaseIdle)
	}
	if !strings.Contains(got.Reason, "no kube context and namespace are bound") {
		t.Errorf("reason = %q, want it to name the missing binding", got.Reason)
	}
}

func TestKubeHealthReportsAnUnknownProject(t *testing.T) {
	a := testApp(t)

	if _, err := a.KubeHealth("nothing", ""); !errors.Is(err, project.ErrNotFound) {
		t.Errorf("KubeHealth on an unregistered project = %v, want ErrNotFound", err)
	}
}

// The bridge onto the stream server: a session's announcement has to reach
// /events, and neither service imports the other.
func TestHealthBridgePublishesOntoTheEventChannel(t *testing.T) {
	application, endpoint := startApp(t)
	events := dialEvents(t, endpoint)

	healthBridge{streams: application.streams}.PublishHealthChanged("/repo")

	frame := events.awaitFrame()
	if frame.Type != "health" {
		t.Fatalf("frame type = %q, want health", frame.Type)
	}
	if frame.Payload.Root != "/repo" {
		t.Errorf("root = %q, want /repo", frame.Payload.Root)
	}
}

// healthBridge takes the server it publishes through, not a global — the same
// shape watchBridge has, and what makes the seam substitutable.
var _ kubewatch.Events = healthBridge{streams: (*stream.Server)(nil)}

// projectRoot returns the worktree of a registered project.
func projectRoot(t *testing.T, a *App, name string) string {
	t.Helper()

	root, err := projectPath(a.projects, name)
	if err != nil {
		t.Fatalf("finding %s: %v", name, err)
	}
	return root
}
