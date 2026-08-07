package project

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// configFile is the registry's filename inside the app's config directory.
const configFile = "projects.yaml"

// appDir is the app's directory under the OS config root:
// ~/Library/Application Support/m6t, ~/.config/m6t, %AppData%\m6t.
const appDir = "m6t"

// homeMarker is the tilde projects.yaml uses to stand in for the user's home
// directory (DESIGN.md §4).
const homeMarker = "~"

// configPerm keeps the registry readable only by its owner. It records where a
// user's infrastructure repositories live, which is not a secret but is not
// something to hand to every account on the machine either.
const configPerm = 0o600

// dirPerm is the matching mode for the app's config directory.
const dirPerm = 0o700

// errNoConfigDir reports a registry built without a usable configuration path.
//
// The app constructs its registry before it can show anything, so a failure to
// locate the OS config directory cannot take the window down with it. It
// becomes a registry that reports this on every call instead — the project list
// shows an error, and the rest of the app still runs.
var errNoConfigDir = errors.New("no configuration directory is available for the project registry")

// tempFile is the scratch name the atomic write publishes from. It is a fixed
// name rather than a random one because every write inside this process is
// serialized by the registry's mutex, and the rename stays atomic regardless —
// two m6t instances racing would produce one winner, which is what a rename
// over a shared config means either way.
const tempFile = configFile + ".tmp"

// ConfigDir reports the app's configuration directory, creating it if it does
// not exist.
//
// os.UserConfigDir is the whole platform story: it already resolves to
// Application Support on macOS, $XDG_CONFIG_HOME or ~/.config on Unix and
// %AppData% on Windows, so there is no per-OS branch here to get wrong.
func ConfigDir() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locating the user config directory: %w", err)
	}
	dir := filepath.Join(root, appDir)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return "", fmt.Errorf("creating %s: %w", dir, err)
	}
	return dir, nil
}

// open confines every file operation below to the registry's own directory.
//
// os.Root is what makes the filenames here constants rather than paths: nothing
// in this package ever names a file outside the config directory, and a
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

// load reads the registry.
//
// A file that is not there yet is an empty registry — first launch is not an
// error. A file that is there and does not parse IS an error, and it is
// returned rather than swallowed: silently starting from empty would present a
// user whose config has a typo with an app that appears to have forgotten every
// project they have, and the next write would make that permanent.
func load(dir string) ([]Project, error) {
	root, err := open(dir)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()

	raw, err := root.ReadFile(configFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", configFile, err)
	}

	var doc document
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", filepath.Join(dir, configFile), err)
	}
	return doc.Projects, nil
}

// save writes the registry atomically: a scratch file in the same directory,
// then a rename over the target.
//
// The rename is what makes it atomic, and the scratch file has to share a
// filesystem with the target for the rename to be one — which the same
// directory guarantees and the system temp dir does not. A crash mid-write
// leaves either the old file or the new one, never a truncated registry.
func save(dir string, projects []Project) error {
	raw, err := yaml.Marshal(document{Projects: projects})
	if err != nil {
		return fmt.Errorf("encoding %s: %w", configFile, err)
	}

	root, err := open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()

	f, err := root.OpenFile(tempFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, configPerm)
	if err != nil {
		return fmt.Errorf("creating %s: %w", tempFile, err)
	}

	// Both paths below must remove the scratch file: a failed save that left one
	// behind would turn one bad write into a growing pile of them.
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

// abbreviate renders an absolute path with the user's home directory as "~",
// matching the form DESIGN.md §4 shows in projects.yaml. A path outside the
// home directory is returned unchanged.
func abbreviate(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	if path == home {
		return homeMarker
	}
	if rest, ok := strings.CutPrefix(path, home+string(filepath.Separator)); ok {
		return homeMarker + string(filepath.Separator) + rest
	}
	return path
}

// expand is abbreviate's inverse: it resolves a leading "~" against the user's
// home directory.
//
// Only a leading "~" followed by a separator (or nothing) expands. "~user" is
// deliberately not supported — it would mean looking up another account's home
// directory to open a repository on their behalf.
// The forward-slash form is what this package writes and what DESIGN.md §4
// documents, so it expands on every platform — a projects.yaml written on a Mac
// must not resolve to a literal directory named "~" on Windows. The platform's
// own separator is accepted as well, for a file someone edited by hand there.
//
// The reverse case is deliberately not handled: a backslash is a legal
// character in a Unix filename, so translating one would corrupt a real path to
// rescue a config that was hand-written for the wrong platform.
// resolved returns the project with both path forms filled in: Path absolute
// for the callers that act on the checkout, ShortPath tilde-abbreviated for the
// one place that shows it. Every operation that hands a Project outward goes
// through it, so the two can never be set apart.
func resolved(p Project) Project {
	p.ShortPath = abbreviate(expand(p.Path))
	p.Path = expand(p.Path)
	return p
}

func expand(path string) string {
	if path == homeMarker {
		return homeDirOr(path)
	}
	rest, ok := afterHomeMarker(path)
	if !ok {
		return path
	}
	home := homeDirOr("")
	if home == "" {
		return path
	}
	return filepath.Join(home, filepath.FromSlash(rest))
}

// afterHomeMarker returns what follows a leading "~/", or a leading "~" and the
// platform separator, and whether the path had one. "~user" is deliberately not
// matched — expanding it would mean opening a repository out of another
// account's home directory.
func afterHomeMarker(path string) (string, bool) {
	if rest, ok := strings.CutPrefix(path, homeMarker+"/"); ok {
		return rest, true
	}
	return strings.CutPrefix(path, homeMarker+string(filepath.Separator))
}

// homeDirOr returns the user's home directory, or fallback when it cannot be
// determined.
func homeDirOr(fallback string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return fallback
	}
	return home
}
