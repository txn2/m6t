package session_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/session"
)

// loadFile writes content as the session file in a fresh directory and loads
// it, which is how every normalization below is exercised: through the store,
// against the file a hand edit or an older build could actually leave.
func loadFile(t *testing.T, content string) session.State {
	t.Helper()
	dir := t.TempDir()
	write(t, dir, content)
	return session.New(dir).Load()
}

func TestLoadDropsRecordsThatNameNoProject(t *testing.T) {
	got := loadFile(t, `
version: 1
projects:
  - name: ""
    editors:
      - path: a.yaml
  - name: infra
    editors:
      - path: b.yaml
`)

	if len(got.Projects) != 1 || got.Projects[0].Name != "infra" {
		t.Errorf("projects = %+v, want only infra", got.Projects)
	}
}

func TestLoadKeepsTheFirstRecordForARepeatedProject(t *testing.T) {
	got := loadFile(t, `
version: 1
projects:
  - name: infra
    activeEditor: first.yaml
    editors:
      - path: first.yaml
  - name: infra
    activeEditor: second.yaml
    editors:
      - path: second.yaml
`)

	if len(got.Projects) != 1 {
		t.Fatalf("projects = %+v, want one record for infra", got.Projects)
	}
	if got.Projects[0].ActiveEditor != "first.yaml" {
		t.Errorf("active editor = %q, want first.yaml", got.Projects[0].ActiveEditor)
	}
}

func TestLoadDropsUnopenableEditorTabs(t *testing.T) {
	got := loadFile(t, `
version: 1
projects:
  - name: infra
    editors:
      - path: ""
      - path: a.yaml
      - path: a.yaml
        mode: preview
      - path: b.yaml
`)

	editors := got.Projects[0].Editors
	if len(editors) != 2 {
		t.Fatalf("editors = %+v, want the nameless and the repeated tab dropped", editors)
	}
	if editors[0].Path != "a.yaml" || editors[0].Mode != "" {
		t.Errorf("first tab = %+v, want the first a.yaml kept as it stood", editors[0])
	}
	if editors[1].Path != "b.yaml" {
		t.Errorf("second tab = %+v, want b.yaml", editors[1])
	}
}

// The selection has to name a tab that is going to exist. A file removed while
// the app was closed takes its tab with it, and the tab strip must not come
// back focused on nothing.
func TestLoadClearsASelectionThatNamesNoTab(t *testing.T) {
	got := loadFile(t, `
version: 1
projects:
  - name: infra
    activeEditor: deleted.yaml
    editors:
      - path: kept.yaml
`)

	if got.Projects[0].ActiveEditor != "" {
		t.Errorf("active editor = %q, want it cleared", got.Projects[0].ActiveEditor)
	}
}

func TestLoadHoldsTheTerminalSelectionInsideTheStrip(t *testing.T) {
	dir := t.TempDir()
	tests := map[string]struct {
		index string
		want  int
	}{
		"past the end":  {index: "7", want: 0},
		"negative":      {index: "-1", want: 0},
		"inside range":  {index: "1", want: 1},
		"the last one":  {index: "2", want: 2},
		"the first one": {index: "0", want: 0},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			got := loadFile(t, `
version: 1
projects:
  - name: infra
    activeTerminal: `+tt.index+`
    terminals:
      - {title: one, cwd: `+dir+`}
      - {title: two, cwd: `+dir+`}
      - {title: three, cwd: `+dir+`}
`)
			if got.Projects[0].ActiveTerminal != tt.want {
				t.Errorf("active terminal = %d, want %d", got.Projects[0].ActiveTerminal, tt.want)
			}
		})
	}
}

// A terminal whose directory is gone keeps its tab and loses its cwd: the
// frontend opens it at the project root, which is the only other place it
// could sensibly go.
func TestLoadClearsAMissingTerminalDirectory(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("writing the file: %v", err)
	}

	got := loadFile(t, `
version: 1
projects:
  - name: infra
    terminals:
      - {title: gone, cwd: `+filepath.Join(dir, "removed")+`}
      - {title: file, cwd: `+file+`}
      - {title: here, cwd: `+dir+`}
`)

	terminals := got.Projects[0].Terminals
	if len(terminals) != 3 {
		t.Fatalf("terminals = %+v, want all three tabs kept", terminals)
	}
	if terminals[0].Cwd != "" || terminals[1].Cwd != "" {
		t.Errorf("terminals = %+v, want the missing directory and the file cleared", terminals)
	}
	if terminals[2].Cwd != dir {
		t.Errorf("third terminal = %+v, want it still at %s", terminals[2], dir)
	}
}

// The project root is the empty string in the tree's path convention, so it is
// a value here and not a blank to be dropped.
func TestLoadKeepsTheRootAmongTheExpandedDirectories(t *testing.T) {
	got := loadFile(t, `
version: 1
projects:
  - name: infra
    treeExpanded: ["", manifests, manifests, ""]
`)

	expanded := got.Projects[0].TreeExpanded
	if strings.Join(expanded, "|") != "|manifests" {
		t.Errorf("expanded = %q, want the root and manifests, each once", expanded)
	}
}

// The caps are what stop a hand-edited or corrupted file from turning a launch
// into an unbounded amount of work: thousands of tabs would each be a file read
// and a mounted pane.
func TestLoadCapsWhatOneFileCanAskFor(t *testing.T) {
	var b strings.Builder
	b.WriteString("version: 1\nprojects:\n")
	for i := range 100 {
		b.WriteString("  - name: p" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + "\n    editors:\n")
		for j := range 300 {
			b.WriteString("      - path: f" + strings.Repeat("x", j%3+1) + string(rune('a'+j%26)) + string(rune('a'+j/26%26)) + "\n")
		}
	}

	got := loadFile(t, b.String())

	if len(got.Projects) > 64 {
		t.Errorf("projects = %d, want at most 64", len(got.Projects))
	}
	for _, p := range got.Projects {
		if len(p.Editors) > 200 {
			t.Errorf("%s has %d editors, want at most 200", p.Name, len(p.Editors))
		}
	}
}

// The frontend is not a trusted producer either: a bug that sent a duplicated
// tab list must not be written to disk and read back as truth.
func TestSaveNormalizesWhatTheFrontendSent(t *testing.T) {
	dir := t.TempDir()
	store := session.New(dir)

	err := store.Save(session.State{
		Version: session.Version,
		Projects: []session.Project{{
			Name: "infra",
			Editors: []session.Editor{
				{Path: "a.yaml"},
				{Path: "a.yaml"},
				{Path: ""},
			},
			ActiveEditor:   "vanished.yaml",
			Terminals:      []session.Terminal{{Title: "shell 1", Cwd: dir}},
			ActiveTerminal: 4,
		}},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	got := store.Load().Projects[0]
	if len(got.Editors) != 1 {
		t.Errorf("editors = %+v, want the duplicate and the empty path dropped", got.Editors)
	}
	if got.ActiveEditor != "" {
		t.Errorf("active editor = %q, want it cleared", got.ActiveEditor)
	}
	if got.ActiveTerminal != 0 {
		t.Errorf("active terminal = %d, want it held inside the strip", got.ActiveTerminal)
	}
}

// A project with nothing open is a record worth keeping — it is how "this
// project has no tabs" survives a restart instead of restoring the tabs it had
// two sessions ago.
func TestSaveKeepsAProjectWithNothingOpen(t *testing.T) {
	dir := t.TempDir()
	store := session.New(dir)

	if err := store.Save(session.State{Projects: []session.Project{{Name: "infra"}}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got := store.Load()
	if len(got.Projects) != 1 || got.Projects[0].Name != "infra" {
		t.Errorf("projects = %+v, want the empty infra record kept", got.Projects)
	}
}
