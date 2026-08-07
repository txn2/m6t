package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// stub writes an executable of the given name into dir.
func stub(t *testing.T, dir, name, body string) {
	t.Helper()

	if _, err := exec.LookPath("sh"); err != nil {
		t.Skipf("no sh available to build a %s stub: %v", name, err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatalf("writing the %s stub: %v", name, err)
	}
}

// byName indexes a detection result so a test can assert about one tool.
func byName(t *testing.T, detected []Tool, name string) Tool {
	t.Helper()

	for _, tool := range detected {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("%s missing from %+v", name, detected)
	return Tool{}
}

func TestDetectReportsVersionsWithTheBoilerplateStripped(t *testing.T) {
	dir := t.TempDir()
	stub(t, dir, "git", `echo "git version 2.43.0"`)
	stub(t, dir, "kubectl", `echo "Client Version: v1.36.2"; echo "Kustomize Version: v5.7.1"`)
	stub(t, dir, "helm", `echo "v3.14.0+g1234abc"`)
	t.Setenv("PATH", dir)

	detected := Detect(context.Background())

	want := map[string]string{"git": "2.43.0", "kubectl": "v1.36.2", "helm": "v3.14.0+g1234abc"}
	for name, version := range want {
		tool := byName(t, detected, name)
		if !tool.Found {
			t.Errorf("%s reported as not found", name)
		}
		if tool.Version != version {
			t.Errorf("%s version = %q, want %q", name, tool.Version, version)
		}
		if tool.Problem != "" {
			t.Errorf("%s problem = %q, want none", name, tool.Problem)
		}
		if tool.Path != filepath.Join(dir, name) {
			t.Errorf("%s path = %q, want %q", name, tool.Path, filepath.Join(dir, name))
		}
	}
}

// A missing tool is a state with a sentence, never an error: DESIGN.md §2
// requires m6t to degrade with "install X" rather than fail obscurely.
func TestDetectReportsAMissingToolAsAState(t *testing.T) {
	dir := t.TempDir()
	stub(t, dir, "git", `echo "git version 2.43.0"`)
	t.Setenv("PATH", dir)

	helm := byName(t, Detect(context.Background()), "helm")
	if helm.Found {
		t.Error("helm reported as found with nothing on PATH")
	}
	if !strings.Contains(helm.Problem, "not found on PATH") {
		t.Errorf("helm problem = %q, want a sentence naming PATH", helm.Problem)
	}
	if helm.Version != "" || helm.Path != "" {
		t.Errorf("missing helm carried %+v, want empty version and path", helm)
	}
}

// A tool that is installed but whose version probe fails is degraded, not
// absent. Reporting it as missing would disable features the user can in fact
// use.
func TestDetectKeepsAToolWhoseProbeFails(t *testing.T) {
	dir := t.TempDir()
	stub(t, dir, "helm", `>&2 echo "unknown flag: --short"; exit 1`)
	t.Setenv("PATH", dir)

	helm := byName(t, Detect(context.Background()), "helm")
	if !helm.Found {
		t.Error("an installed helm reported as not found because its probe failed")
	}
	if !strings.Contains(helm.Problem, "unknown flag") {
		t.Errorf("helm problem = %q, want the tool's own stderr", helm.Problem)
	}
	if helm.Version != "" {
		t.Errorf("helm version = %q, want none", helm.Version)
	}
}

// A probe that exits zero and prints nothing leaves the tool usable but
// unnamed, which is its own sentence rather than a silent empty version.
func TestDetectReportsASilentProbe(t *testing.T) {
	dir := t.TempDir()
	stub(t, dir, "kubectl", `exit 0`)
	t.Setenv("PATH", dir)

	kubectl := byName(t, Detect(context.Background()), "kubectl")
	if !kubectl.Found {
		t.Error("kubectl reported as not found")
	}
	if !strings.Contains(kubectl.Problem, "no version") {
		t.Errorf("kubectl problem = %q, want a sentence about the missing version", kubectl.Problem)
	}
}

// The order is fixed so a refresh does not reshuffle the list under the user's
// cursor.
func TestDetectReturnsAStableOrder(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	names := make([]string, 0, len(probes))
	for _, tool := range Detect(context.Background()) {
		names = append(names, tool.Name)
	}
	if got, want := strings.Join(names, ","), "git,kubectl,helm"; got != want {
		t.Errorf("detection order = %q, want %q", got, want)
	}
}

func TestCleanTakesTheFirstUsefulLine(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		out    string
		prefix string
		want   string
	}{
		{name: "prefix stripped", out: "git version 2.43.0\n", prefix: "git version ", want: "2.43.0"},
		{name: "leading blank lines skipped", out: "\n\n  v3.14.0\n", want: "v3.14.0"},
		{name: "later lines ignored", out: "Client Version: v1.36\nKustomize: v5\n", prefix: "Client Version: ", want: "v1.36"},
		{name: "absent prefix left alone", out: "v3.14.0\n", prefix: "git version ", want: "v3.14.0"},
		{name: "no output", out: "   \n\n", want: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := clean(test.out, test.prefix); got != test.want {
				t.Errorf("clean(%q, %q) = %q, want %q", test.out, test.prefix, got, test.want)
			}
		})
	}
}
