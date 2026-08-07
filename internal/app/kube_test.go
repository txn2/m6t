package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/kubeexec"
	"github.com/txn2/m6t/internal/project"
)

// boundApp registers a project with the dev/prod layout scopes exist for
// (DESIGN.md §4) and returns the binding alongside the project's name.
func boundApp(t *testing.T) (a *App, name string) {
	t.Helper()

	a = testApp(t)
	a.kube = kubeexec.New()

	added, err := a.AddProject(repoDir(t, "infra"), "")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	if _, err := a.UpdateProject(added.Name, project.Settings{Kube: project.Kube{
		Context:   "prod-us-west",
		Namespace: "default",
		Scopes: []project.Scope{
			{Path: "dev", Context: "dev-cluster", Namespace: "dev"},
			{Path: "prod", Protected: true},
			{Path: "prod/api", Namespace: "api"},
		},
	}}); err != nil {
		t.Fatalf("UpdateProject: %v", err)
	}
	return a, added.Name
}

func TestKubeBindingResolvesThroughTheRegistry(t *testing.T) {
	a, name := boundApp(t)

	tests := []struct {
		rel  string
		want project.Binding
	}{
		{rel: "", want: project.Binding{Context: "prod-us-west", Namespace: "default"}},
		{rel: "dev/api/x.yaml", want: project.Binding{Context: "dev-cluster", Namespace: "dev", Scope: "dev"}},
		{rel: "prod/api/x.yaml", want: project.Binding{
			Context: "prod-us-west", Namespace: "api", Protected: true, Scope: "prod/api",
		}},
	}

	for _, test := range tests {
		got, err := a.KubeBinding(name, test.rel)
		if err != nil {
			t.Fatalf("KubeBinding(%q): %v", test.rel, err)
		}
		if got != test.want {
			t.Errorf("KubeBinding(%q) = %+v, want %+v", test.rel, got, test.want)
		}
	}
}

func TestKubeBindingReportsAnUnknownProject(t *testing.T) {
	a := testApp(t)

	if _, err := a.KubeBinding("nothing", ""); !errors.Is(err, project.ErrNotFound) {
		t.Errorf("KubeBinding on an unregistered project error = %v, want ErrNotFound", err)
	}
}

// The settings write is refused whole when a scope does not name a subtree of
// the repository — a half-stored safety setting is worse than a rejected form.
func TestUpdateProjectRefusesAScopeOutsideTheRepository(t *testing.T) {
	a := testApp(t)
	added, err := a.AddProject(repoDir(t, "infra"), "")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	_, err = a.UpdateProject(added.Name, project.Settings{Kube: project.Kube{
		Context:   "prod",
		Namespace: "default",
		Scopes:    []project.Scope{{Path: "../elsewhere", Context: "somewhere-else"}},
	}})
	if !errors.Is(err, project.ErrInvalidScope) {
		t.Fatalf("UpdateProject with an escaping scope error = %v, want ErrInvalidScope", err)
	}

	// Nothing was written: the whole update was refused, binding included.
	settings, err := a.projects.Settings(added.Name)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Kube.Context != "" || settings.Kube.Scopes != nil {
		t.Errorf("settings after a refused update = %+v, want the project still unbound", settings.Kube)
	}
}

// The acceptance criterion at the binding layer: an unbound project reaches no
// cluster, and the refusal is an error rather than a Result, because nothing
// ran to produce one.
func TestKubeCheckRefusesAnUnboundProject(t *testing.T) {
	a := testApp(t)
	a.kube = kubeexec.New()

	added, err := a.AddProject(repoDir(t, "infra"), "")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	if _, err := a.KubeCheck(added.Name, ""); !errors.Is(err, kubeexec.ErrUnbound) {
		t.Errorf("KubeCheck on an unbound project error = %v, want ErrUnbound", err)
	}
}

// KubeCheck resolves the target itself rather than accepting one over the
// bridge, so the scope that applies to the selected path is what gets aimed at.
// The resolution failing means there is no target, which is a different thing
// to report than a cluster that refused: no kubectl is reached at all.
func TestKubeCheckReportsAnUnknownProject(t *testing.T) {
	a := testApp(t)
	a.kube = kubeexec.New()

	if _, err := a.KubeCheck("nothing", ""); !errors.Is(err, project.ErrNotFound) {
		t.Errorf("KubeCheck on an unregistered project error = %v, want ErrNotFound", err)
	}
}

func TestKubeCheckAimsAtTheResolvedScope(t *testing.T) {
	a, name := boundApp(t)

	dir := t.TempDir()
	script := "#!/bin/sh\necho \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o700); err != nil {
		t.Fatalf("writing the kubectl stub: %v", err)
	}
	t.Setenv("PATH", dir)

	result, err := a.KubeCheck(name, "dev/api/deployment.yaml")
	if err != nil {
		t.Fatalf("KubeCheck: %v", err)
	}
	if !strings.Contains(result.Stdout, "--context=dev-cluster --namespace=dev") {
		t.Errorf("kubectl received %q, want the dev scope's context and namespace", result.Stdout)
	}
}

func TestKubeContextsReadsTheUsersKubeconfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	body := `
apiVersion: v1
kind: Config
current-context: dev
clusters: [{name: dev-cluster, cluster: {server: https://dev.example}}]
users: [{name: dev-user, user: {}}]
contexts: [{name: dev, context: {cluster: dev-cluster, user: dev-user}}]
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing a kubeconfig: %v", err)
	}
	t.Setenv("KUBECONFIG", path)

	config, err := (&App{}).KubeContexts()
	if err != nil {
		t.Fatalf("KubeContexts: %v", err)
	}
	if len(config.Contexts) != 1 || config.Contexts[0].Name != "dev" {
		t.Errorf("contexts = %+v, want the one in the kubeconfig", config.Contexts)
	}
}

func TestKubeContextsReportsABrokenKubeconfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte("\tnot: [valid"), 0o600); err != nil {
		t.Fatalf("writing a kubeconfig: %v", err)
	}
	t.Setenv("KUBECONFIG", path)

	if _, err := (&App{}).KubeContexts(); err == nil {
		t.Error("KubeContexts on a broken kubeconfig returned no error, want one")
	}
}

func TestToolsReportsEveryBinaryM6tDrives(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	detected := (&App{}).Tools()

	names := make([]string, 0, len(detected))
	for _, tool := range detected {
		names = append(names, tool.Name)
	}
	if got, want := strings.Join(names, ","), "git,kubectl,helm"; got != want {
		t.Errorf("Tools() = %q, want %q", got, want)
	}
}

func TestBindFolderAndUnbindFolderRoundTrip(t *testing.T) {
	a, name := boundApp(t)

	if _, err := a.BindFolder(name, "staging", "staging-cluster", "staging", false); err != nil {
		t.Fatalf("BindFolder: %v", err)
	}

	got, err := a.KubeBinding(name, "staging/x.yaml")
	if err != nil {
		t.Fatalf("KubeBinding: %v", err)
	}
	want := project.Binding{Context: "staging-cluster", Namespace: "staging", Scope: "staging"}
	if got != want {
		t.Errorf("binding after BindFolder = %+v, want %+v", got, want)
	}

	if _, err := a.UnbindFolder(name, "staging"); err != nil {
		t.Fatalf("UnbindFolder: %v", err)
	}

	got, err = a.KubeBinding(name, "staging/x.yaml")
	if err != nil {
		t.Fatalf("KubeBinding after unbind: %v", err)
	}
	if got != (project.Binding{Context: "prod-us-west", Namespace: "default"}) {
		t.Errorf("binding after UnbindFolder = %+v, want the project default", got)
	}
}

// A folder that overrides only the namespace keeps the context above it — the
// repository whose environments share a cluster.
func TestBindFolderCanOverrideTheNamespaceAlone(t *testing.T) {
	a, name := boundApp(t)

	if _, err := a.BindFolder(name, "prod/web", "", "web", false); err != nil {
		t.Fatalf("BindFolder: %v", err)
	}

	got, err := a.KubeBinding(name, "prod/web/deployment.yaml")
	if err != nil {
		t.Fatalf("KubeBinding: %v", err)
	}
	want := project.Binding{
		Context: "prod-us-west", Namespace: "web", Protected: true, Scope: "prod/web",
	}
	if got != want {
		t.Errorf("binding = %+v, want %+v", got, want)
	}
}

func TestBindFolderRefusesAPathOutsideTheRepository(t *testing.T) {
	a, name := boundApp(t)

	if _, err := a.BindFolder(name, "../elsewhere", "x", "y", false); !errors.Is(err, project.ErrInvalidScope) {
		t.Errorf("BindFolder with an escaping path error = %v, want ErrInvalidScope", err)
	}
}

func TestFolderBindingsReportAnUnknownProject(t *testing.T) {
	a := testApp(t)

	if _, err := a.BindFolder("nothing", "dev", "c", "n", false); !errors.Is(err, project.ErrNotFound) {
		t.Errorf("BindFolder error = %v, want ErrNotFound", err)
	}
	if _, err := a.UnbindFolder("nothing", "dev"); !errors.Is(err, project.ErrNotFound) {
		t.Errorf("UnbindFolder error = %v, want ErrNotFound", err)
	}
}

func TestKubeNamespacesListsWhatTheClusterOffers(t *testing.T) {
	// Not parallel: t.Setenv rewrites process-wide PATH.
	a := testApp(t)
	a.kube = kubeexec.New()

	dir := t.TempDir()
	script := "#!/bin/sh\necho namespace/default\necho namespace/kube-system\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o700); err != nil {
		t.Fatalf("writing the kubectl stub: %v", err)
	}
	t.Setenv("PATH", dir)

	got, err := a.KubeNamespaces("prod-us-west")
	if err != nil {
		t.Fatalf("KubeNamespaces: %v", err)
	}
	if strings.Join(got, ",") != "default,kube-system" {
		t.Errorf("namespaces = %v, want the cluster's own list", got)
	}
}

func TestKubeNamespacesReportsAFailure(t *testing.T) {
	a := testApp(t)
	a.kube = kubeexec.New()

	if _, err := a.KubeNamespaces(""); !errors.Is(err, kubeexec.ErrUnbound) {
		t.Errorf("KubeNamespaces with no context error = %v, want ErrUnbound", err)
	}
}
