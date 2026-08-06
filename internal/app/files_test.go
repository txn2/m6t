package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/watch"
)

func TestReadFileAndWriteFileRoundTripThroughTheBinding(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")
	seed(t, root, "deploy.yaml", "kind: Deployment\n")

	read, err := a.ReadFile(root, "deploy.yaml")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if read.Content != "kind: Deployment\n" {
		t.Errorf("Content = %q, want %q", read.Content, "kind: Deployment\n")
	}

	if err := a.WriteFile(root, "deploy.yaml", read.Content+"spec: {}\n", read.CRLF); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	onDisk, err := os.ReadFile(filepath.Join(root, "deploy.yaml"))
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if string(onDisk) != "kind: Deployment\nspec: {}\n" {
		t.Errorf("on-disk content = %q, want %q", onDisk, "kind: Deployment\nspec: {}\n")
	}
}

// The read-only flags are what the editor UI gates writing on, so the
// binding has to carry them across the bridge rather than flatten them into
// a plain string.
func TestReadFileCarriesTheReadOnlyFlagsAcrossTheBinding(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")
	seed(t, root, "mixed.yaml", "a: 1\r\nb: 2\n")

	got, err := a.ReadFile(root, "mixed.yaml")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !got.MixedEOL || !got.ReadOnly {
		t.Errorf("MixedEOL/ReadOnly = %v/%v, want both true for a mixed-EOL file",
			got.MixedEOL, got.ReadOnly)
	}
}

// Every bound method wraps what its service returned, so a failure names the
// file and the project it happened in rather than arriving as a bare stat
// error the frontend cannot attribute (the contract tree.go, terminals.go
// and projects.go already hold).
func TestReadFileWrapsTheUnderlyingErrorWithPathAndRoot(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")

	_, err := a.ReadFile(root, "missing.yaml")
	if err == nil {
		t.Fatal("ReadFile on a missing file succeeded, want an error")
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("ReadFile error = %v, want it to wrap os.ErrNotExist", err)
	}
	if !strings.Contains(err.Error(), "missing.yaml") {
		t.Errorf("ReadFile error = %q, want it to name the file", err)
	}
	if !strings.Contains(err.Error(), root) {
		t.Errorf("ReadFile error = %q, want it to name the project root", err)
	}
}

func TestWriteFileWrapsTheUnderlyingErrorWithPathAndRoot(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")

	err := a.WriteFile(root, ".git/HEAD", "x", false)
	if !errors.Is(err, watch.ErrGitInternal) {
		t.Fatalf("WriteFile(.git/HEAD) = %v, want it to wrap watch.ErrGitInternal", err)
	}
	if !strings.Contains(err.Error(), ".git/HEAD") || !strings.Contains(err.Error(), root) {
		t.Errorf("WriteFile error = %q, want it to name the file and the project root", err)
	}
}

// seed writes a fixture into a project's worktree.
func seed(t *testing.T, root, relPath, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, relPath), []byte(content), 0o640); err != nil {
		t.Fatalf("seeding %s: %v", relPath, err)
	}
}

func TestReadPrefixesCarriesHeadsAcrossTheBinding(t *testing.T) {
	a := testApp(t)
	root := repoDir(t, "infra")
	seed(t, root, "deploy.yaml", "apiVersion: apps/v1\nkind: Deployment\n")

	prefixes, err := a.ReadPrefixes(root, []string{"deploy.yaml", "absent.yaml"})
	if err != nil {
		t.Fatalf("ReadPrefixes: %v", err)
	}
	if got := prefixes["deploy.yaml"]; !strings.Contains(got, "kind: Deployment") {
		t.Errorf("deploy.yaml head = %q, want the file's content", got)
	}
	// A path that cannot answer is absent rather than fatal: the tree asks
	// about a whole directory at once and a file deleted between the listing
	// and the call must not cost the other answers.
	if _, ok := prefixes["absent.yaml"]; ok {
		t.Errorf("prefixes = %v, want the missing file omitted", prefixes)
	}
}

func TestReadPrefixesWrapsTheUnderlyingErrorWithRoot(t *testing.T) {
	a := testApp(t)
	root := filepath.Join(t.TempDir(), "not-a-project")

	_, err := a.ReadPrefixes(root, []string{"deploy.yaml"})
	if err == nil {
		t.Fatal("ReadPrefixes on a missing root succeeded, want an error")
	}
	if !strings.Contains(err.Error(), root) {
		t.Errorf("ReadPrefixes error = %q, want it to name the project root", err)
	}
}
