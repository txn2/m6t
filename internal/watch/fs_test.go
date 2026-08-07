package watch

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// tree builds a temp worktree with the given files (empty content) and
// directories, plus a .git directory holding one file — the shape every
// exclusion test in this file has to see refused.
func tree(t *testing.T, files, dirs []string) string {
	t.Helper()
	root := t.TempDir()
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(root, d), 0o750); err != nil {
			t.Fatalf("making directory %s: %v", d, err)
		}
	}
	for _, f := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, f)), 0o750); err != nil {
			t.Fatalf("making parent of %s: %v", f, err)
		}
		if err := os.WriteFile(filepath.Join(root, f), []byte("x"), 0o640); err != nil {
			t.Fatalf("writing file %s: %v", f, err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, ".git", "refs", "heads"), 0o750); err != nil {
		t.Fatalf("making .git: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o640); err != nil {
		t.Fatalf("writing .git/HEAD: %v", err)
	}
	return root
}

func TestListReturnsDirectoriesFirstThenCaseInsensitiveByName(t *testing.T) {
	root := tree(t, []string{"b.yaml", "A.md", "z.txt"}, []string{"nested"})

	entries, err := List(root, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	want := []Entry{
		{Name: "nested", IsDir: true},
		{Name: "A.md", IsDir: false},
		{Name: "b.yaml", IsDir: false},
		{Name: "z.txt", IsDir: false},
	}
	if len(entries) != len(want) {
		t.Fatalf("List = %+v, want %+v", entries, want)
	}
	for i, e := range entries {
		if e != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, e, want[i])
		}
	}
}

func TestListExcludesGit(t *testing.T) {
	root := tree(t, []string{"a.yaml"}, nil)

	entries, err := List(root, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, e := range entries {
		if e.Name == gitDir {
			t.Errorf("List included %q, want .git excluded", gitDir)
		}
	}
}

func TestListOfANestedDirectory(t *testing.T) {
	root := tree(t, []string{"manifests/deploy.yaml"}, nil)

	entries, err := List(root, "manifests")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 || entries[0].Name != "deploy.yaml" {
		t.Errorf("List(manifests) = %+v, want [deploy.yaml]", entries)
	}
}

func TestListRejectsPathsEscapingRoot(t *testing.T) {
	root := tree(t, nil, nil)

	for _, relPath := range []string{"../etc", "../../etc/passwd", "a/../../b"} {
		if _, err := List(root, relPath); !errors.Is(err, ErrOutsideRoot) {
			t.Errorf("List(%q) = %v, want ErrOutsideRoot", relPath, err)
		}
	}
}

func TestListRejectsAbsolutePaths(t *testing.T) {
	root := tree(t, nil, nil)

	if _, err := List(root, "/etc"); !errors.Is(err, ErrOutsideRoot) {
		t.Errorf("List(/etc) = %v, want ErrOutsideRoot", err)
	}
}

func TestListRejectsGitInternals(t *testing.T) {
	root := tree(t, nil, nil)

	for _, relPath := range []string{".git", ".git/refs", ".git/refs/heads"} {
		if _, err := List(root, relPath); !errors.Is(err, ErrGitInternal) {
			t.Errorf("List(%q) = %v, want ErrGitInternal", relPath, err)
		}
	}
}

func TestListRejectsASymlinkEscapingRoot(t *testing.T) {
	root := tree(t, nil, nil)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if _, err := List(root, "escape"); err == nil {
		t.Error("List(escape) = nil error, want the symlink refused")
	}
}

func TestCreateAddsAFileAndADirectory(t *testing.T) {
	root := tree(t, nil, nil)

	if err := Create(root, "a.yaml", false); err != nil {
		t.Fatalf("Create(a.yaml): %v", err)
	}
	if err := Create(root, "sub", true); err != nil {
		t.Fatalf("Create(sub, dir): %v", err)
	}

	entries, err := List(root, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("List after create = %+v, want 2 entries", entries)
	}

	info, err := os.Stat(filepath.Join(root, "a.yaml"))
	if err != nil || info.IsDir() {
		t.Errorf("a.yaml stat = %v, IsDir = %v, want a plain file", err, info != nil && info.IsDir())
	}
}

func TestCreateRejectsAnExistingTarget(t *testing.T) {
	root := tree(t, []string{"a.yaml"}, nil)

	if err := Create(root, "a.yaml", false); !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("Create over an existing file = %v, want ErrAlreadyExists", err)
	}
}

func TestCreateRejectsAMissingParent(t *testing.T) {
	root := tree(t, nil, nil)

	if err := Create(root, "missing/a.yaml", false); err == nil {
		t.Error("Create under a missing parent = nil error, want a failure")
	}
}

func TestCreateDirectoryRejectsAMissingParent(t *testing.T) {
	root := tree(t, nil, nil)

	if err := Create(root, "missing/sub", true); err == nil {
		t.Error("Create(dir) under a missing parent = nil error, want a failure")
	}
}

func TestOperationsFailOverANonexistentRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "does-not-exist")

	if _, err := List(root, ""); err == nil {
		t.Error("List over a missing root succeeded, want an error")
	}
	if err := Create(root, "a.yaml", false); err == nil {
		t.Error("Create over a missing root succeeded, want an error")
	}
	if err := Rename(root, "a.yaml", "b.yaml"); err == nil {
		t.Error("Rename over a missing root succeeded, want an error")
	}
	if err := Delete(root, "a.yaml"); err == nil {
		t.Error("Delete over a missing root succeeded, want an error")
	}
}

func TestCreateRejectsRoot(t *testing.T) {
	root := tree(t, nil, nil)

	for _, relPath := range []string{"", "."} {
		if err := Create(root, relPath, true); !errors.Is(err, ErrNoPath) {
			t.Errorf("Create(%q) = %v, want ErrNoPath", relPath, err)
		}
	}
}

func TestCreateRejectsGitInternals(t *testing.T) {
	root := tree(t, nil, nil)

	if err := Create(root, ".git/hooks/pre-commit", false); !errors.Is(err, ErrGitInternal) {
		t.Errorf("Create(.git/hooks/pre-commit) = %v, want ErrGitInternal", err)
	}
}

func TestCreateRejectsPathsEscapingRoot(t *testing.T) {
	root := tree(t, nil, nil)

	if err := Create(root, "../escape.yaml", false); !errors.Is(err, ErrOutsideRoot) {
		t.Errorf("Create(../escape.yaml) = %v, want ErrOutsideRoot", err)
	}
}

func TestRenameMovesAnEntry(t *testing.T) {
	root := tree(t, []string{"old.yaml"}, nil)

	if err := Rename(root, "old.yaml", "new.yaml"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "old.yaml")); !os.IsNotExist(err) {
		t.Errorf("old.yaml still exists after rename: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "new.yaml")); err != nil {
		t.Errorf("new.yaml missing after rename: %v", err)
	}
}

func TestRenameNeverOverwrites(t *testing.T) {
	root := tree(t, []string{"a.yaml", "b.yaml"}, nil)

	if err := Rename(root, "a.yaml", "b.yaml"); !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("Rename onto an existing file = %v, want ErrAlreadyExists", err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "b.yaml")); err != nil || len(data) == 0 {
		t.Errorf("b.yaml was touched by the refused rename: data=%q err=%v", data, err)
	}
}

func TestRenameFailsWhenTheDestinationParentIsNotADirectory(t *testing.T) {
	root := tree(t, []string{"a.yaml", "blocker"}, nil)

	if err := Rename(root, "a.yaml", "blocker/x.yaml"); err == nil {
		t.Error("Rename with a file as the destination's parent = nil error, want a failure")
	}
}

func TestRenameFailsWhenTheDestinationDirectoryIsMissing(t *testing.T) {
	root := tree(t, []string{"a.yaml"}, nil)

	if err := Rename(root, "a.yaml", "missing-dir/a.yaml"); err == nil {
		t.Error("Rename into a missing directory = nil error, want a failure")
	}
}

func TestRenameRejectsGitInternals(t *testing.T) {
	root := tree(t, []string{"a.yaml"}, nil)

	if err := Rename(root, "a.yaml", ".git/a.yaml"); !errors.Is(err, ErrGitInternal) {
		t.Errorf("Rename into .git = %v, want ErrGitInternal", err)
	}
	if err := Rename(root, ".git/HEAD", "head.txt"); !errors.Is(err, ErrGitInternal) {
		t.Errorf("Rename out of .git = %v, want ErrGitInternal", err)
	}
}

func TestDeleteRemovesAFile(t *testing.T) {
	root := tree(t, []string{"a.yaml"}, nil)

	if err := Delete(root, "a.yaml"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a.yaml")); !os.IsNotExist(err) {
		t.Errorf("a.yaml still exists after delete: %v", err)
	}
}

func TestDeleteRemovesADirectoryAndItsContents(t *testing.T) {
	root := tree(t, []string{"sub/a.yaml", "sub/nested/b.yaml"}, nil)

	if err := Delete(root, "sub"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "sub")); !os.IsNotExist(err) {
		t.Errorf("sub still exists after delete: %v", err)
	}
}

func TestDeleteRejectsRootAndGit(t *testing.T) {
	root := tree(t, nil, nil)

	if err := Delete(root, ""); !errors.Is(err, ErrNoPath) {
		t.Errorf("Delete(root) = %v, want ErrNoPath", err)
	}
	if err := Delete(root, ".git"); !errors.Is(err, ErrGitInternal) {
		t.Errorf("Delete(.git) = %v, want ErrGitInternal", err)
	}
}

func TestDeleteOfAMissingEntryIsIdempotent(t *testing.T) {
	root := tree(t, nil, nil)

	// os.Root.RemoveAll mirrors os.RemoveAll: removing something already gone
	// is success, not an error — the tree UI's confirm-then-delete flow can
	// race a change from outside the app without surfacing a spurious failure.
	if err := Delete(root, "missing.yaml"); err != nil {
		t.Errorf("Delete of a missing entry = %v, want nil", err)
	}
}

func TestResolveReturnsTheAbsolutePathAndItsKind(t *testing.T) {
	root := tree(t, []string{"prod/api/deploy.yaml"}, []string{"prod/api"})

	tests := []struct {
		name    string
		rel     string
		wantRel string
		wantDir bool
	}{
		{name: "file", rel: "prod/api/deploy.yaml", wantRel: "prod/api/deploy.yaml"},
		{name: "directory", rel: "prod/api", wantRel: "prod/api", wantDir: true},
		{name: "root itself", rel: "", wantRel: ".", wantDir: true},
		{name: "slash form on every platform", rel: "prod/api/../api", wantRel: "prod/api", wantDir: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, isDir, err := Resolve(root, test.rel)
			if err != nil {
				t.Fatalf("Resolve(%q): %v", test.rel, err)
			}
			want := filepath.Join(root, filepath.FromSlash(test.wantRel))
			if got != want {
				t.Errorf("path = %q, want %q", got, want)
			}
			if isDir != test.wantDir {
				t.Errorf("isDir = %v, want %v", isDir, test.wantDir)
			}
		})
	}
}

// The reason this function exists: the path leaves the process, so everything
// that would escape the worktree has to be refused before it does.
func TestResolveRefusesWhatWouldLeaveTheWorktree(t *testing.T) {
	root := tree(t, []string{"prod/deploy.yaml"}, nil)

	tests := []struct {
		name string
		rel  string
		want error
	}{
		{name: "parent traversal", rel: "../outside.yaml", want: ErrOutsideRoot},
		{name: "traversal through a real directory", rel: "prod/../../outside.yaml", want: ErrOutsideRoot},
		{name: "absolute path", rel: "/etc/passwd", want: ErrOutsideRoot},
		{name: "the git directory", rel: ".git/config", want: ErrGitInternal},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := Resolve(root, test.rel); !errors.Is(err, test.want) {
				t.Errorf("Resolve(%q) error = %v, want %v", test.rel, err, test.want)
			}
		})
	}
}

// The runtime half of the confinement: a symlink is a path that passes every
// static check and still points somewhere else, and only os.Root catches it.
func TestResolveRefusesASymlinkOutOfTheWorktree(t *testing.T) {
	root := tree(t, nil, nil)
	outside := filepath.Join(t.TempDir(), "secrets.yaml")
	if err := os.WriteFile(outside, []byte("x"), 0o600); err != nil {
		t.Fatalf("writing the target: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.yaml")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if _, _, err := Resolve(root, "escape.yaml"); err == nil {
		t.Error("Resolve followed a symlink out of the worktree, want a refusal")
	}
}

// A path that names nothing fails here rather than inside kubectl, where it
// would arrive as a file-not-found with no mention of the project it was
// relative to.
func TestResolveRefusesAMissingPath(t *testing.T) {
	root := tree(t, nil, nil)

	if _, _, err := Resolve(root, "prod/gone.yaml"); err == nil {
		t.Error("Resolve of a path that does not exist returned no error, want one")
	}
}
