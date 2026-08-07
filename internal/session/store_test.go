package session_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/session"
)

// saved is a session with something in every field, used by the round-trip
// tests so that a field dropped from the encoding fails a test rather than
// disappearing quietly.
func saved(cwd string) session.State {
	return session.State{
		Version:        session.Version,
		ActiveProject:  "infra",
		FontSize:       15,
		Sidebar:        320,
		TerminalHeight: 240,
		ChangedOnly:    true,
		Projects: []session.Project{{
			Name: "infra",
			Editors: []session.Editor{
				{Path: "manifests/prod/ingress.yaml", Mode: "edit"},
				{Path: "README.md", Mode: "preview"},
			},
			ActiveEditor:   "README.md",
			Terminals:      []session.Terminal{{Title: "shell 1", Cwd: cwd}},
			ActiveTerminal: 0,
			TreeExpanded:   []string{"", "manifests", "manifests/prod"},
			TreeSelected:   "manifests/prod/ingress.yaml",
			TreeShowHidden: true,
		}},
	}
}

func TestSaveThenLoadReturnsTheSameSession(t *testing.T) {
	dir := t.TempDir()
	store := session.New(dir)
	want := saved(dir)

	if err := store.Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got := store.Load()
	if got.Version != session.Version {
		t.Errorf("version = %d, want %d", got.Version, session.Version)
	}
	if got.ActiveProject != want.ActiveProject || got.FontSize != want.FontSize {
		t.Errorf("window settings = %q/%d, want %q/%d",
			got.ActiveProject, got.FontSize, want.ActiveProject, want.FontSize)
	}
	if got.Sidebar != want.Sidebar || got.TerminalHeight != want.TerminalHeight || !got.ChangedOnly {
		t.Errorf("panes = %d/%d changedOnly=%v, want %d/%d changedOnly=true",
			got.Sidebar, got.TerminalHeight, got.ChangedOnly, want.Sidebar, want.TerminalHeight)
	}
	if len(got.Projects) != 1 {
		t.Fatalf("projects = %d, want 1", len(got.Projects))
	}

	project := got.Projects[0]
	if project.Name != "infra" || project.ActiveEditor != "README.md" {
		t.Errorf("project identity = %q/%q, want infra/README.md", project.Name, project.ActiveEditor)
	}
	if len(project.Editors) != 2 || project.Editors[1].Mode != "preview" {
		t.Errorf("editors = %+v, want two tabs with the second in preview", project.Editors)
	}
	if len(project.Terminals) != 1 || project.Terminals[0].Cwd != dir {
		t.Errorf("terminals = %+v, want one at %s", project.Terminals, dir)
	}
	if strings.Join(project.TreeExpanded, "|") != "|manifests|manifests/prod" {
		t.Errorf("expanded = %v, want the root and two directories", project.TreeExpanded)
	}
	if project.TreeSelected != "manifests/prod/ingress.yaml" || !project.TreeShowHidden {
		t.Errorf("tree = %q/%v, want the selection and the hidden-files filter kept",
			project.TreeSelected, project.TreeShowHidden)
	}
}

func TestLoadWithoutAFileIsTheZeroSession(t *testing.T) {
	got := session.New(t.TempDir()).Load()

	if got.Version != 0 || len(got.Projects) != 0 || got.ActiveProject != "" {
		t.Errorf("first launch loaded %+v, want the zero session", got)
	}
}

// A session file the user or a crash left unreadable must open the app at its
// defaults. This is the rule that separates it from projects.yaml, where the
// same input is an error the user is told about.
func TestLoadIgnoresAnUnusableFile(t *testing.T) {
	tests := map[string]string{
		"cut mid-string":       "version: 1\nprojects:\n  - name: infra\n    editors:\n      - path: \"manif",
		"not YAML at all":      "\x00\x01\x02 not a session",
		"a newer schema":       "version: 99\nactiveProject: infra\n",
		"a schema from before": "version: 0\nactiveProject: infra\n",
		"empty":                "",
	}

	for name, content := range tests {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			write(t, dir, content)

			got := session.New(dir).Load()
			if got.Version != 0 || got.ActiveProject != "" || len(got.Projects) != 0 {
				t.Errorf("loaded %+v from %q, want the zero session", got, content)
			}
		})
	}
}

// The unusable file stays on disk until something overwrites it: a load must
// not "repair" the config directory behind the user's back.
func TestLoadLeavesAnUnusableFileAlone(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "not a session")

	session.New(dir).Load()

	raw, err := os.ReadFile(filepath.Join(dir, "session.yaml"))
	if err != nil {
		t.Fatalf("reading the session file back: %v", err)
	}
	if string(raw) != "not a session" {
		t.Errorf("session file = %q, want it untouched", raw)
	}
}

func TestSaveReplacesAPreviousSession(t *testing.T) {
	dir := t.TempDir()
	store := session.New(dir)

	if err := store.Save(saved(dir)); err != nil {
		t.Fatalf("first Save: %v", err)
	}
	if err := store.Save(session.State{ActiveProject: "apps"}); err != nil {
		t.Fatalf("second Save: %v", err)
	}

	got := store.Load()
	if got.ActiveProject != "apps" {
		t.Errorf("active project = %q, want apps", got.ActiveProject)
	}
	if len(got.Projects) != 0 {
		t.Errorf("projects = %+v, want the previous session's records replaced", got.Projects)
	}
}

// Save stamps the version rather than trusting the caller's, so a frontend that
// sent a zero-valued state cannot write a file its own next launch discards.
func TestSaveStampsTheSchemaVersion(t *testing.T) {
	dir := t.TempDir()

	if err := session.New(dir).Save(session.State{FontSize: 14}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "session.yaml"))
	if err != nil {
		t.Fatalf("reading the session file: %v", err)
	}
	if !strings.Contains(string(raw), "version: 1") {
		t.Errorf("session file = %q, want it to carry version 1", raw)
	}
}

func TestSaveLeavesNoScratchFileBehind(t *testing.T) {
	dir := t.TempDir()

	if err := session.New(dir).Save(saved(dir)); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, "session.yaml.tmp")); !os.IsNotExist(err) {
		t.Errorf("stat of the scratch file = %v, want it gone", err)
	}
}

// The session records where a user's repositories are and which files they are
// editing. It is not a secret, but it is not for every account on the machine
// either — the same reasoning projects.yaml is written under.
func TestSaveWritesAnOwnerOnlyFile(t *testing.T) {
	dir := t.TempDir()

	if err := session.New(dir).Save(saved(dir)); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(filepath.Join(dir, "session.yaml"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %04o, want 0600", perm)
	}
}

// A store with no configuration directory is what the app builds when the OS
// will not say where one is. It must not panic, must load defaults, and must
// report the failure when asked to write.
func TestStoreWithoutAConfigDirectory(t *testing.T) {
	store := session.New("")

	if got := store.Load(); got.Version != 0 {
		t.Errorf("Load = %+v, want the zero session", got)
	}
	if err := store.Save(saved("")); err == nil {
		t.Error("Save succeeded with no configuration directory, want an error")
	}
}

func TestSaveReportsAnUnwritableDirectory(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes through a read-only directory mode")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	if err := session.New(dir).Save(saved(dir)); err == nil {
		t.Error("Save succeeded into a read-only directory, want an error")
	}
}

// write puts content in the store's file inside dir.
func write(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "session.yaml"), []byte(content), 0o600); err != nil {
		t.Fatalf("writing the session file: %v", err)
	}
}
