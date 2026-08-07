package session

import (
	"errors"
	"fmt"
	"os"
	"sync"

	"gopkg.in/yaml.v3"
)

// configFile is the session's filename inside the app's config directory. It
// sits beside projects.yaml, in the directory internal/project resolves —
// there is one configuration directory, and this package is handed it rather
// than working it out a second time.
const configFile = "session.yaml"

// tempFile is the scratch name the atomic write publishes from. A fixed name is
// safe for the same reason the registry's is: writes here are serialized by the
// store's mutex, and a rename over the target is atomic regardless.
const tempFile = configFile + ".tmp"

// configPerm keeps the session readable only by its owner. It records which
// repositories are open and which files inside them are being edited, which is
// not something to publish to every account on the machine.
const configPerm = 0o600

// errNoConfigDir reports a store built without a usable configuration path.
var errNoConfigDir = errors.New("no configuration directory is available for the session")

// Store reads and writes the session file.
//
// Like the project registry it caches nothing: the frontend holds the live
// session and hands over a whole state to save, so a copy kept here would be a
// second answer to the same question with no way to tell which one is stale.
type Store struct {
	// dir is the configuration directory holding session.yaml. Every file
	// operation is confined to it (see open).
	dir string

	// mu serializes writes. Wails dispatches bound calls concurrently, and the
	// frontend's debounced save can be in flight when the next one is
	// requested.
	mu sync.Mutex
}

// New builds a store backed by session.yaml inside dir.
func New(dir string) *Store { return &Store{dir: dir} }

// Load reports the stored session, or the zero session when there is not a
// usable one.
//
// It returns no error, and that is the whole design of this file rather than a
// convenience. Every failure it can meet — no file yet, a file this build's
// schema does not match, a truncated write, a directory that cannot be read —
// has exactly one sensible answer for a user who is trying to open their
// editor: start at the defaults. An error here could only become a dialog
// about a file the user did not know existed, in front of an app that was
// about to work fine.
//
// What it deliberately does NOT do is repair the file. A session that does not
// parse stays on disk until the next save overwrites it, so a bad state is
// recoverable by reading it, not only by having been there when it happened.
func (s *Store) Load() State {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := s.read()
	if err != nil {
		return State{}
	}

	var stored State
	if err := yaml.Unmarshal(raw, &stored); err != nil {
		return State{}
	}
	if stored.Version != Version {
		return State{}
	}
	return normalize(stored)
}

// read returns the session file's bytes.
func (s *Store) read() ([]byte, error) {
	root, err := open(s.dir)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()

	raw, err := root.ReadFile(configFile)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", configFile, err)
	}
	return raw, nil
}

// Save writes the session, atomically: a scratch file in the same directory,
// then a rename over the target.
//
// The rename is what makes it atomic, and the scratch file has to share a
// filesystem with the target for the rename to be one — the same shape
// internal/project/store.go uses for the registry, and duplicated rather than
// shared because these are sibling packages and a service may not import
// another. What is duplicated is fifteen lines of file handling; what would be
// shared is a third package existing only to hold them.
//
// Unlike Load this does report failure. A write that did not land is the one
// thing the caller could conceivably act on, and swallowing it here would mean
// the bound method could never do anything but lie.
func (s *Store) Save(state State) error {
	raw, err := yaml.Marshal(normalize(state))
	if err != nil {
		return fmt.Errorf("encoding %s: %w", configFile, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	root, err := open(s.dir)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()

	f, err := root.OpenFile(tempFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, configPerm)
	if err != nil {
		return fmt.Errorf("creating %s: %w", tempFile, err)
	}

	// Both paths below must remove the scratch file: a failed save that left
	// one behind would turn one bad write into a growing pile of them.
	if err := writeAll(f, raw); err != nil {
		_ = root.Remove(tempFile)
		return err
	}
	if err := root.Rename(tempFile, configFile); err != nil {
		_ = root.Remove(tempFile)
		return fmt.Errorf("replacing %s: %w", configFile, err)
	}
	return nil
}

// open confines every file operation above to the configuration directory.
//
// os.Root is what makes the filenames here constants rather than paths:
// nothing in this package ever names a file outside that directory, and a
// traversal out of it is refused by the kernel-level check rather than by a
// convention this code would have to keep.
func open(dir string) (*os.Root, error) {
	if dir == "" {
		return nil, errNoConfigDir
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", dir, err)
	}
	return root, nil
}

// writeAll writes raw to f and closes it, syncing before the close so the
// rename that follows publishes durable content rather than an empty file with
// the right name.
func writeAll(f *os.File, raw []byte) error {
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		return fmt.Errorf("writing %s: %w", f.Name(), err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("syncing %s: %w", f.Name(), err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", f.Name(), err)
	}
	return nil
}

// existingDir returns path when it is still a directory, and empty otherwise.
//
// This is the one filesystem question this package answers about the workspace
// it stores, and it answers it for terminals only. A terminal's cwd is
// absolute, so "is it still there" is answerable here; an editor tab's path is
// relative to a project root this package does not know, and inventing one to
// check it would mean duplicating the registry. Those tabs are validated where
// the answer is already being fetched — the frontend reads the file to fill the
// tab, and a read that fails is a tab that is not restored.
func existingDir(path string) string {
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return ""
	}
	return path
}
