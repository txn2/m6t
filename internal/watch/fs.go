package watch

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
)

// List returns the immediate children of relPath under root — "" and "."
// both mean root itself — directories first, then case-insensitive by name.
//
// It is not recursive. The tree UI loads one directory at a time (DESIGN.md
// §5), so a caller asking for everything at once is asking for something
// List deliberately does not offer — that restraint is what keeps opening a
// 5,000-file repository cheap.
func List(root, relPath string) ([]Entry, error) {
	r, err := openRoot(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.Close() }()

	name, err := rootRelative(relPath)
	if err != nil {
		return nil, err
	}

	items, err := fs.ReadDir(r.FS(), name)
	if err != nil {
		return nil, fmt.Errorf("listing %s: %w", relPath, err)
	}

	entries := make([]Entry, 0, len(items))
	for _, item := range items {
		if item.Name() == gitDir {
			continue
		}
		entries = append(entries, Entry{Name: item.Name(), IsDir: item.IsDir()})
	}
	sortEntries(entries)
	return entries, nil
}

// Resolve turns a repository-relative path into the absolute one an external
// tool is handed, and reports whether it names a directory.
//
// It exists because kubectl is a separate process and cannot be confined the
// way everything else in this package is: `kubectl apply -f` takes a path and
// opens it itself, outside the os.Root this file does all its own work through.
// So the confinement has to happen before the path leaves — this proves the
// target is inside the worktree, and what the caller passes on is a path that
// was checked rather than one that was concatenated.
//
// The proof is the Stat: it runs through the same os.Root every other operation
// here uses, so a symlink pointing out of the repository fails here rather than
// resolving quietly inside kubectl. That is the half fs.ValidPath cannot do —
// the static check refuses "..", and only the runtime check refuses a link that
// was created after it.
//
// The directory answer is returned rather than left to the caller to Stat again
// because the caller would have to do it outside the root to get it, which is
// the confinement given back one line after it was established. It is what
// decides `--recursive`, and getting it wrong applies nothing and reports
// success (see kubeexec.withSource).
func Resolve(root, relPath string) (native string, isDir bool, err error) {
	r, err := openRoot(root)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = r.Close() }()

	name, err := rootRelative(relPath)
	if err != nil {
		return "", false, err
	}

	info, err := r.Stat(name)
	if err != nil {
		return "", false, fmt.Errorf("resolving %s: %w", relPath, err)
	}
	return filepath.Join(root, filepath.FromSlash(name)), info.IsDir(), nil
}

// Create makes a new empty file or directory at relPath, which must not
// already exist. The parent directory must already exist — Create adds one
// node at a time, the same as the tree UI action that calls it.
func Create(root, relPath string, isDir bool) error {
	r, err := openRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = r.Close() }()

	name, err := entryRelative(relPath)
	if err != nil {
		return err
	}
	native := filepath.FromSlash(name)

	if isDir {
		if err := r.Mkdir(native, dirPerm); err != nil {
			return fmt.Errorf("creating directory %s: %w", relPath, existsOr(err))
		}
		return nil
	}

	f, err := r.OpenFile(native, os.O_CREATE|os.O_EXCL|os.O_WRONLY, filePerm)
	if err != nil {
		return fmt.Errorf("creating file %s: %w", relPath, existsOr(err))
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("creating file %s: %w", relPath, err)
	}
	return nil
}

// Rename moves fromRelPath to toRelPath within root. The destination must
// not already exist: unlike a bare filesystem rename, this never overwrites
// — a tree UI's "type a new name over an existing one" has to fail loudly,
// not silently destroy what was there.
func Rename(root, fromRelPath, toRelPath string) error {
	r, err := openRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = r.Close() }()

	from, err := entryRelative(fromRelPath)
	if err != nil {
		return err
	}
	to, err := entryRelative(toRelPath)
	if err != nil {
		return err
	}
	nativeFrom, nativeTo := filepath.FromSlash(from), filepath.FromSlash(to)

	if _, err := r.Lstat(nativeTo); err == nil {
		return fmt.Errorf("renaming %s to %s: %w", fromRelPath, toRelPath, ErrAlreadyExists)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("renaming %s to %s: %w", fromRelPath, toRelPath, err)
	}

	if err := r.Rename(nativeFrom, nativeTo); err != nil {
		return fmt.Errorf("renaming %s to %s: %w", fromRelPath, toRelPath, err)
	}
	return nil
}

// Delete removes relPath — a file outright, a directory and everything in
// it. The confirmation a deletion this destructive needs is the tree UI's
// job (the issue's "confirm on delete" criterion); by the time this runs,
// the user has already agreed.
func Delete(root, relPath string) error {
	r, err := openRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = r.Close() }()

	name, err := entryRelative(relPath)
	if err != nil {
		return err
	}

	if err := r.RemoveAll(filepath.FromSlash(name)); err != nil {
		return fmt.Errorf("deleting %s: %w", relPath, err)
	}
	return nil
}

// openRoot opens root as an os.Root, the confinement every operation in this
// file runs through.
func openRoot(root string) (*os.Root, error) {
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", root, err)
	}
	return r, nil
}

// rootRelative validates relPath — the wire form is always slash-separated,
// regardless of platform — and returns the fs.FS-compatible name for it.
// "" and "." both mean root itself.
//
// fs.ValidPath is the authoritative syntactic check: it refuses "..",
// absolute paths and the other shapes fs.FS forbids, on every platform,
// before os.Root's own runtime symlink-escape check ever runs. Two
// independent guards rather than one, because they catch different attacks:
// this one is static, os.Root's is what a symlink created after this check
// still cannot get past.
func rootRelative(relPath string) (string, error) {
	trimmed := relPath
	if trimmed == "" {
		trimmed = "."
	}
	clean := path.Clean(filepath.ToSlash(trimmed))
	if !fs.ValidPath(clean) {
		return "", fmt.Errorf("resolving %s: %w", relPath, ErrOutsideRoot)
	}
	if clean == gitDir || len(clean) > len(gitDir) && clean[:len(gitDir)+1] == gitDir+"/" {
		return "", fmt.Errorf("resolving %s: %w", relPath, ErrGitInternal)
	}
	return clean, nil
}

// entryRelative is rootRelative for an operation that names a concrete
// entry — Create, Rename and Delete cannot target root itself.
func entryRelative(relPath string) (string, error) {
	name, err := rootRelative(relPath)
	if err != nil {
		return "", err
	}
	if name == "." {
		return "", fmt.Errorf("resolving %s: %w", relPath, ErrNoPath)
	}
	return name, nil
}

// existsOr reports ErrAlreadyExists for an os.Root creation call that failed
// because its target is already there, and err unchanged otherwise.
func existsOr(err error) error {
	if errors.Is(err, fs.ErrExist) {
		return ErrAlreadyExists
	}
	return err
}
