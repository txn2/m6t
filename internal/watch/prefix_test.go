package watch

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestReadPrefixesReturnsFileHeads(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	write(t, root, "manifests/deploy.yaml", "apiVersion: apps/v1\nkind: Deployment\n")
	write(t, root, "codecov.yml", "coverage:\n  status: off\n")

	prefixes, err := ReadPrefixes(root, []string{"manifests/deploy.yaml", "codecov.yml"})
	if err != nil {
		t.Fatalf("ReadPrefixes: %v", err)
	}
	if got := prefixes["manifests/deploy.yaml"]; got != "apiVersion: apps/v1\nkind: Deployment\n" {
		t.Errorf("deploy.yaml head = %q", got)
	}
	if got := prefixes["codecov.yml"]; got != "coverage:\n  status: off\n" {
		t.Errorf("codecov.yml head = %q", got)
	}
}

func TestReadPrefixesStopsAtPrefixLen(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	// Twice the ceiling, so a reader that ignored the limit would be caught
	// by the length rather than by the content happening to match.
	write(t, root, "big.yaml", strings.Repeat("a", prefixLen*2))

	prefixes, err := ReadPrefixes(root, []string{"big.yaml"})
	if err != nil {
		t.Fatalf("ReadPrefixes: %v", err)
	}
	if got := len(prefixes["big.yaml"]); got != prefixLen {
		t.Errorf("head length = %d, want %d", got, prefixLen)
	}
}

func TestReadPrefixesOmitsWhatCannotAnswer(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	write(t, root, "manifests/deploy.yaml", "apiVersion: v1\nkind: Pod\n")
	write(t, root, "logo.png", "PNG\x00\x01binary")
	if err := os.MkdirAll(filepath.Join(root, "charts"), 0o750); err != nil {
		t.Fatalf("mkdir charts: %v", err)
	}

	// One good path alongside every shape that cannot contribute: a
	// directory, a file that is not there, a binary, a path outside the root
	// and one reaching into .git.
	asked := []string{
		"manifests/deploy.yaml",
		"charts",
		"gone.yaml",
		"logo.png",
		"../escape.yaml",
		".git/config",
	}
	prefixes, err := ReadPrefixes(root, asked)
	if err != nil {
		t.Fatalf("ReadPrefixes: %v", err)
	}

	if len(prefixes) != 1 {
		t.Fatalf("prefixes = %v, want only manifests/deploy.yaml", prefixes)
	}
	if _, ok := prefixes["manifests/deploy.yaml"]; !ok {
		t.Errorf("the readable manifest is missing from %v", prefixes)
	}
}

func TestReadPrefixesRefusesAnOversizedBatch(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	write(t, root, "a.yaml", "kind: Pod\n")

	// The cap exists so this binding cannot be turned into a repository
	// walk; one over it is the smallest case that must still be refused.
	asked := make([]string, 1025)
	for i := range asked {
		asked[i] = "a" + strconv.Itoa(i) + ".yaml"
	}

	if _, err := ReadPrefixes(root, asked); err == nil {
		t.Fatal("ReadPrefixes accepted an oversized batch")
	}
}

func TestReadPrefixesFailsOnAnUnopenableRoot(t *testing.T) {
	t.Parallel()

	if _, err := ReadPrefixes(filepath.Join(t.TempDir(), "absent"), []string{"a.yaml"}); err == nil {
		t.Fatal("ReadPrefixes accepted a root that does not exist")
	}
}

func TestReadPrefixesReturnsEmptyForNoPaths(t *testing.T) {
	t.Parallel()

	prefixes, err := ReadPrefixes(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("ReadPrefixes: %v", err)
	}
	if len(prefixes) != 0 {
		t.Errorf("prefixes = %v, want empty", prefixes)
	}
}

func TestReadPrefixesSkipsWhatIsNotARegularFile(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs elevation on Windows")
	}
	root := t.TempDir()
	write(t, root, "deploy.yaml", "apiVersion: v1\nkind: Pod\n")
	if err := os.Symlink(filepath.Join(root, "deploy.yaml"), filepath.Join(root, "link.yaml")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	prefixes, err := ReadPrefixes(root, []string{"deploy.yaml", "link.yaml"})
	if err != nil {
		t.Fatalf("ReadPrefixes: %v", err)
	}

	// The check that keeps this from opening a named pipe and blocking on it
	// is the same one that rejects a symlink; a repository is allowed to
	// contain either.
	if _, ok := prefixes["link.yaml"]; ok {
		t.Errorf("prefixes = %v, want the symlink skipped", prefixes)
	}
	if _, ok := prefixes["deploy.yaml"]; !ok {
		t.Errorf("prefixes = %v, want the regular file read", prefixes)
	}
}
