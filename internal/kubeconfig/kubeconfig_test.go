package kubeconfig

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// write drops a kubeconfig into a temp directory and returns its path.
func write(t *testing.T, body string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing a kubeconfig: %v", err)
	}
	return path
}

const twoContexts = `
apiVersion: v1
kind: Config
current-context: dev
clusters:
  - name: dev-cluster
    cluster: {server: https://dev.example}
  - name: prod-cluster
    cluster: {server: https://prod.example}
users:
  - name: dev-user
    user: {}
  - name: prod-user
    user: {}
contexts:
  - name: prod
    context: {cluster: prod-cluster, user: prod-user, namespace: platform}
  - name: dev
    context: {cluster: dev-cluster, user: dev-user}
`

func TestLoadListsContextsSortedWithTheCurrentOneFlagged(t *testing.T) {
	t.Setenv("KUBECONFIG", write(t, twoContexts))

	config, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	want := []Context{
		{Name: "dev", Cluster: "dev-cluster", User: "dev-user", Current: true},
		{Name: "prod", Cluster: "prod-cluster", User: "prod-user", Namespace: "platform"},
	}
	if !reflect.DeepEqual(config.Contexts, want) {
		t.Errorf("contexts = %+v, want %+v", config.Contexts, want)
	}
}

// The kubeconfig's current-context is reported as a flag and nothing more.
// Nothing in m6t may treat it as a binding (DESIGN.md §4), and a Config that
// carried a "selected" field would be the first step toward one.
func TestLoadReportsCurrentContextWithoutSelectingIt(t *testing.T) {
	t.Setenv("KUBECONFIG", write(t, twoContexts))

	config, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	current := 0
	for _, entry := range config.Contexts {
		if entry.Current {
			current++
		}
	}
	if current != 1 {
		t.Errorf("%d contexts flagged current, want exactly 1", current)
	}
}

// A machine with no clusters configured is an ordinary state, not a failure:
// the settings dialog says so, and it needs a list to say it about.
func TestLoadTreatsAMissingKubeconfigAsEmpty(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nothing-here")
	t.Setenv("KUBECONFIG", missing)

	config, err := Load()
	if err != nil {
		t.Fatalf("Load with no kubeconfig returned an error: %v", err)
	}
	if len(config.Contexts) != 0 {
		t.Errorf("contexts = %+v, want none", config.Contexts)
	}
	if len(config.Sources) == 0 {
		t.Error("Sources is empty; the empty state has no path to name")
	}
}

// A kubeconfig that exists and will not parse is an error. Reporting it as an
// empty list would tell a user with a broken file that they have no clusters,
// which is a different problem with a different fix.
func TestLoadReportsAnUnparseableKubeconfig(t *testing.T) {
	t.Setenv("KUBECONFIG", write(t, "\tthis is not: [valid yaml"))

	if _, err := Load(); err == nil {
		t.Error("Load on a broken kubeconfig returned no error, want one")
	}
}

// KUBECONFIG is a path list, and the merge is what makes m6t's context list
// agree with `kubectl config get-contexts`. A hand-rolled reader of a single
// file would show a user half their clusters.
func TestLoadMergesEveryFileInKubeconfig(t *testing.T) {
	first := write(t, twoContexts)
	second := write(t, `
apiVersion: v1
kind: Config
clusters:
  - name: staging-cluster
    cluster: {server: https://staging.example}
users:
  - name: staging-user
    user: {}
contexts:
  - name: staging
    context: {cluster: staging-cluster, user: staging-user}
`)
	t.Setenv("KUBECONFIG", first+string(os.PathListSeparator)+second)

	config, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	names := make([]string, 0, len(config.Contexts))
	for _, entry := range config.Contexts {
		names = append(names, entry.Name)
	}
	if got, want := strings.Join(names, ","), "dev,prod,staging"; got != want {
		t.Errorf("merged contexts = %q, want %q", got, want)
	}
	if len(config.Sources) != 2 {
		t.Errorf("Sources = %v, want both files in precedence order", config.Sources)
	}
}
