package app

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/kubeexec"
	"github.com/txn2/m6t/internal/project"
)

// pipelineApp registers a project holding real manifest files, binds it the way
// DESIGN.md §4's layout does — a protected `prod` tree and an unprotected `dev`
// one — and puts a kubectl stub on PATH that records having run.
//
// The stub is a real process rather than an injected seam because that is what
// makes "nothing ran" assertable: kubeexec's exec seam is unexported, so the
// only honest way for this package to prove no invocation happened is to give it
// something that would leave a mark if one had.
func pipelineApp(t *testing.T) (a *App, name string, ran func() bool) {
	t.Helper()

	root := repoDir(t, "infra")
	putManifest(t, root, "dev/api/deploy.yaml")
	putManifest(t, root, "prod/api/deploy.yaml")

	a = testApp(t)
	a.kube = kubeexec.New()

	added, err := a.AddProject(root, "")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if _, err := a.UpdateProject(added.Name, project.Settings{Kube: project.Kube{
		Context:   "dev-cluster",
		Namespace: "default",
		Scopes: []project.Scope{
			{Path: "prod", Context: "prod-us-west", Namespace: "platform", Protected: true},
		},
	}}); err != nil {
		t.Fatalf("UpdateProject: %v", err)
	}

	marker := filepath.Join(t.TempDir(), "ran")
	t.Setenv("M6T_TEST_MARKER", marker)
	stub := filepath.Join(t.TempDir(), "kubectl")
	script := "#!/bin/sh\n: > \"$M6T_TEST_MARKER\"\necho \"$@\"\n"
	if err := os.WriteFile(stub, []byte(script), 0o700); err != nil {
		t.Fatalf("writing the kubectl stub: %v", err)
	}
	t.Setenv("PATH", filepath.Dir(stub))

	return a, added.Name, func() bool {
		_, err := os.Stat(marker)
		return err == nil
	}
}

func putManifest(t *testing.T, root, rel string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		t.Fatalf("making %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte("kind: Deployment\n"), 0o640); err != nil {
		t.Fatalf("writing %s: %v", rel, err)
	}
}

// The invariant every binding in this file carries: the cluster comes from the
// registry's resolution of the target's own path, and the path kubectl is given
// is the absolute one inside the worktree.
func TestPipelineAimsWhereTheRegistryResolves(t *testing.T) {
	a, name, _ := pipelineApp(t)

	result, err := a.KubeValidate(name, "prod/api/deploy.yaml")
	if err != nil {
		t.Fatalf("KubeValidate: %v", err)
	}

	got := strings.Fields(strings.TrimSpace(result.Stdout))
	want := []string{
		"--context=prod-us-west",
		"--namespace=platform",
		"apply",
		"--dry-run=server",
	}
	for _, flag := range want {
		if !slices.Contains(got, flag) {
			t.Errorf("kubectl received %v, want it to carry %s", got, flag)
		}
	}
	if slices.Contains(got, "--recursive") {
		t.Errorf("kubectl received %v, want no --recursive for a single file", got)
	}
	if !slices.Contains(got, "--filename="+filepath.Join(worktreeOf(t, a, name), "prod", "api", "deploy.yaml")) {
		t.Errorf("kubectl received %v, want the absolute path inside the worktree", got)
	}
}

// worktreeOf is the path of a registered project, for a test asserting the path
// kubectl was handed. A free function rather than a method on *App, because the
// god-object gate counts methods on that type and a test helper is not bound
// API.
func worktreeOf(t *testing.T, a *App, name string) string {
	t.Helper()
	path, err := projectPath(a.projects, name)
	if err != nil {
		t.Fatalf("projectPath: %v", err)
	}
	return path
}

// A directory recurses. Without it kubectl reads the immediate children and
// silently ignores every subdirectory, which in the layout scopes exist for
// means applying nothing and reporting success.
func TestApplyingADirectoryRecurses(t *testing.T) {
	a, name, _ := pipelineApp(t)

	result, err := a.KubeValidate(name, "dev")
	if err != nil {
		t.Fatalf("KubeValidate: %v", err)
	}
	if !strings.Contains(result.Stdout, "--recursive") {
		t.Errorf("kubectl received %q, want --recursive for a directory", result.Stdout)
	}
}

// The acceptance criterion: on a protected binding, apply is impossible without
// typing the context name, and the typed value is checked exactly. Asserted
// twice over — the call was refused, and no kubectl process was created.
func TestAProtectedApplyRequiresTheExactContext(t *testing.T) {
	tests := []struct {
		name  string
		typed string
	}{
		{name: "nothing typed", typed: ""},
		{name: "a different context", typed: "dev-cluster"},
		{name: "the project default rather than the resolved one", typed: "dev-cluster"},
		{name: "trailing whitespace", typed: "prod-us-west "},
		{name: "leading whitespace", typed: " prod-us-west"},
		{name: "wrong case", typed: "PROD-US-WEST"},
		{name: "a prefix", typed: "prod-us"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			a, name, ran := pipelineApp(t)

			_, err := a.KubeApply(name, "prod/api/deploy.yaml", test.typed)
			if err == nil {
				t.Fatalf("KubeApply with %q was allowed, want a refusal", test.typed)
			}
			if !strings.Contains(err.Error(), "protected") {
				t.Errorf("error = %v, want it to say the binding is protected", err)
			}
			if ran() {
				t.Error("kubectl ran, want the refusal to happen before any process exists")
			}
		})
	}
}

// The other half of the same criterion: the exact context is accepted, and the
// apply that follows is a real one rather than another dry run.
func TestAProtectedApplyProceedsOnTheExactContext(t *testing.T) {
	a, name, ran := pipelineApp(t)

	result, err := a.KubeApply(name, "prod/api/deploy.yaml", "prod-us-west")
	if err != nil {
		t.Fatalf("KubeApply: %v", err)
	}
	if !ran() {
		t.Fatal("kubectl did not run, want the apply to have been invoked")
	}
	if strings.Contains(result.Stdout, "--dry-run") {
		t.Errorf("kubectl received %q, want an apply rather than a dry run", result.Stdout)
	}
}

// Delete is protected on the same terms as apply — DESIGN.md §6.1 names both,
// and a guard that covered one of them would leave the more destructive half
// open.
func TestAProtectedDeleteRequiresTheExactContext(t *testing.T) {
	a, name, ran := pipelineApp(t)

	if _, err := a.KubeDelete(name, "prod/api/deploy.yaml", "dev-cluster"); err == nil {
		t.Fatal("KubeDelete with the wrong context was allowed, want a refusal")
	}
	if ran() {
		t.Error("kubectl ran, want the refusal to happen before any process exists")
	}

	if _, err := a.KubeDelete(name, "prod/api/deploy.yaml", "prod-us-west"); err != nil {
		t.Fatalf("KubeDelete with the exact context: %v", err)
	}
	if !ran() {
		t.Error("kubectl did not run for a confirmed delete")
	}
}

// An unprotected binding does not ask for a typed context, because DESIGN.md
// §6.1 makes typing the context protection's own feature rather than every
// apply's. The dialog still restates the target; that is the UI's step 3.
func TestAnUnprotectedApplyNeedsNoTypedContext(t *testing.T) {
	a, name, ran := pipelineApp(t)

	if _, err := a.KubeApply(name, "dev/api/deploy.yaml", ""); err != nil {
		t.Fatalf("KubeApply on an unprotected binding: %v", err)
	}
	if !ran() {
		t.Error("kubectl did not run, want an unprotected apply to proceed")
	}
}

// The read-only steps are read-only for everyone: a protected binding must
// still be inspectable, or the user is asked to confirm an apply they were
// never allowed to preview.
func TestTheReadOnlyStepsRunOnAProtectedBinding(t *testing.T) {
	a, name, _ := pipelineApp(t)

	steps := map[string]func() (kubeexec.Result, error){
		"validate":       func() (kubeexec.Result, error) { return a.KubeValidate(name, "prod/api/deploy.yaml") },
		"diff":           func() (kubeexec.Result, error) { return a.KubeDiff(name, "prod/api/deploy.yaml") },
		"delete preview": func() (kubeexec.Result, error) { return a.KubeDeletePreview(name, "prod/api/deploy.yaml") },
	}
	for step, run := range steps {
		t.Run(step, func(t *testing.T) {
			if _, err := run(); err != nil {
				t.Errorf("%s on a protected binding: %v", step, err)
			}
		})
	}
}

// Delete's dry run lists what would go without removing anything — the issue's
// "Delete dry-run lists the objects before anything is removed".
func TestDeletePreviewIsADryRun(t *testing.T) {
	a, name, _ := pipelineApp(t)

	result, err := a.KubeDeletePreview(name, "dev/api/deploy.yaml")
	if err != nil {
		t.Fatalf("KubeDeletePreview: %v", err)
	}
	if !strings.Contains(result.Stdout, "delete") || !strings.Contains(result.Stdout, "--dry-run=server") {
		t.Errorf("kubectl received %q, want a delete under a server dry run", result.Stdout)
	}
}

// Nothing the pipeline runs asks for server-side apply (#69).
//
// It is asserted at the binding layer as well as inside internal/kubeexec,
// because this is the path a setting would come back down: the flag was removed
// by deleting the project field that carried it, and a future field wired
// through `aim` would reach kubectl without the package's own test noticing.
func TestNoPipelineStepAsksForServerSideApply(t *testing.T) {
	a, name, _ := pipelineApp(t)

	steps := map[string]func() (kubeexec.Result, error){
		"validate":       func() (kubeexec.Result, error) { return a.KubeValidate(name, "dev/api/deploy.yaml") },
		"diff":           func() (kubeexec.Result, error) { return a.KubeDiff(name, "dev/api/deploy.yaml") },
		"apply":          func() (kubeexec.Result, error) { return a.KubeApply(name, "dev/api/deploy.yaml", "") },
		"delete preview": func() (kubeexec.Result, error) { return a.KubeDeletePreview(name, "dev/api/deploy.yaml") },
		"delete":         func() (kubeexec.Result, error) { return a.KubeDelete(name, "dev/api/deploy.yaml", "") },
	}
	for step, run := range steps {
		t.Run(step, func(t *testing.T) {
			result, err := run()
			if err != nil {
				t.Fatalf("%s: %v", step, err)
			}
			// The fake kubectl echoes its argv, so an empty Stdout would make
			// the check below pass without having looked at anything.
			if !strings.Contains(result.Stdout, "--context=") {
				t.Fatalf("stdout = %q, want the argv the fake kubectl echoes", result.Stdout)
			}
			if strings.Contains(result.Stdout, "--server-side") {
				t.Errorf("kubectl received %q, which asks for server-side apply", result.Stdout)
			}
		})
	}
}

// A target that is not inside the worktree is refused before kubectl exists.
// The path leaves the process on the argv, so this is the last place it can be
// checked at all.
func TestThePipelineRefusesATargetOutsideTheWorktree(t *testing.T) {
	for _, target := range []string{"../outside.yaml", "dev/../../outside.yaml", "/etc/passwd", ".git/config"} {
		t.Run(target, func(t *testing.T) {
			a, name, ran := pipelineApp(t)

			if _, err := a.KubeValidate(name, target); err == nil {
				t.Fatalf("KubeValidate(%q) was allowed, want a refusal", target)
			}
			if ran() {
				t.Error("kubectl ran on a path outside the worktree")
			}
		})
	}
}

// A path that names nothing is refused here rather than inside kubectl, where it
// would arrive as a file-not-found that never mentions the project.
func TestThePipelineRefusesAMissingTarget(t *testing.T) {
	a, name, ran := pipelineApp(t)

	if _, err := a.KubeValidate(name, "dev/api/gone.yaml"); err == nil {
		t.Fatal("KubeValidate on a path that does not exist was allowed, want a refusal")
	}
	if ran() {
		t.Error("kubectl ran on a path that does not exist")
	}
}

func TestThePipelineReportsAnUnknownProject(t *testing.T) {
	a, _, _ := pipelineApp(t)

	if _, err := a.KubeValidate("nothing", "dev"); err == nil {
		t.Error("KubeValidate on an unregistered project returned no error, want one")
	}
}

// An unbound project reaches no cluster at all, which is kubeexec's refusal
// arriving through this layer rather than a second copy of the rule here.
func TestThePipelineRefusesAnUnboundProject(t *testing.T) {
	a := testApp(t)
	a.kube = kubeexec.New()
	root := repoDir(t, "unbound")
	putManifest(t, root, "deploy.yaml")

	added, err := a.AddProject(root, "")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if _, err := a.KubeApply(added.Name, "deploy.yaml", ""); err == nil {
		t.Error("KubeApply on an unbound project was allowed, want a refusal")
	}
}

// Every binding names its own operation and project in front of whatever the
// service returned, so a failure the UI shows says which control produced it.
// Asserted over all five at once: a wrap left off one of them is the case a
// per-binding test would be least likely to be written for.
func TestEveryPipelineBindingNamesItsOperation(t *testing.T) {
	a, name, _ := pipelineApp(t)
	// No kubectl at all, so every call fails at the same place and the only
	// thing distinguishing the five errors is what each one says about itself.
	t.Setenv("PATH", t.TempDir())

	calls := map[string]struct {
		run  func() (kubeexec.Result, error)
		want string
	}{
		"validate":       {run: func() (kubeexec.Result, error) { return a.KubeValidate(name, "dev") }, want: "validating dev"},
		"diff":           {run: func() (kubeexec.Result, error) { return a.KubeDiff(name, "dev") }, want: "diffing dev"},
		"apply":          {run: func() (kubeexec.Result, error) { return a.KubeApply(name, "dev", "") }, want: "applying dev"},
		"delete preview": {run: func() (kubeexec.Result, error) { return a.KubeDeletePreview(name, "dev") }, want: "previewing the delete of dev"},
		"delete":         {run: func() (kubeexec.Result, error) { return a.KubeDelete(name, "dev", "") }, want: "deleting dev"},
	}

	for label, call := range calls {
		t.Run(label, func(t *testing.T) {
			_, err := call.run()
			if err == nil {
				t.Fatalf("%s with no kubectl on PATH returned no error, want one", label)
			}
			if !strings.Contains(err.Error(), call.want) {
				t.Errorf("error = %v, want it to name the operation (%q)", err, call.want)
			}
			if !strings.Contains(err.Error(), name) {
				t.Errorf("error = %v, want it to name the project %q", err, name)
			}
		})
	}
}

// The read-only steps refuse a target outside the worktree too — the guard is
// in the shared resolution, so a binding that skipped it would show up here
// rather than only on the mutating pair.
func TestEveryPipelineBindingConfinesItsTarget(t *testing.T) {
	a, name, ran := pipelineApp(t)

	calls := map[string]func() (kubeexec.Result, error){
		"validate":       func() (kubeexec.Result, error) { return a.KubeValidate(name, "../out.yaml") },
		"diff":           func() (kubeexec.Result, error) { return a.KubeDiff(name, "../out.yaml") },
		"apply":          func() (kubeexec.Result, error) { return a.KubeApply(name, "../out.yaml", "") },
		"delete preview": func() (kubeexec.Result, error) { return a.KubeDeletePreview(name, "../out.yaml") },
		"delete":         func() (kubeexec.Result, error) { return a.KubeDelete(name, "../out.yaml", "") },
	}

	for label, call := range calls {
		t.Run(label, func(t *testing.T) {
			if _, err := call(); err == nil {
				t.Fatalf("%s was allowed outside the worktree, want a refusal", label)
			}
			if ran() {
				t.Error("kubectl ran on a path outside the worktree")
			}
		})
	}
}
