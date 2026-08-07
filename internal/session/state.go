// Package session holds the workspace session: the record of what the window
// was showing when it was last closed, so that reopening m6t resumes the
// workspace instead of rebuilding it by hand (#58).
//
// It is deliberately a second file beside projects.yaml rather than a section
// inside it. The registry is durable configuration — hand-editable, plausibly
// version-controlled, and the one thing in the config directory whose loss
// costs the user something they cannot get back by clicking. A session is
// scratch: where the cursor happened to be at quit. Keeping them apart is what
// makes this package's rule safe — a session file that does not parse is
// silently replaced by defaults, which would be an unforgivable answer for the
// registry and is the only sensible one here.
//
// It imports nothing first-party. Like the registry and the PTY service it is
// composed by internal/app, which is also where its directory comes from: the
// configuration path is resolved once, for both files.
package session

// Version is the schema this package reads and writes.
//
// A file carrying any other version is discarded rather than migrated. The
// alternative — best-effort reading of a shape this build does not know — buys
// nothing that matters here, because everything in the file is recoverable by
// the user opening a file and dragging a divider, and it costs the one property
// that makes a scratch format safe to change: that an older or newer m6t can
// never half-read a session and act on the half it understood.
const Version = 1

// Structural caps. They are not UI limits — how wide a sidebar may be and how
// large a font may be are the frontend's rules, held in its own constants and
// applied when it restores. These bound what a *file* may contain, so that a
// session.yaml that was hand-edited, corrupted, or written by a future build
// cannot turn a launch into an unbounded amount of work.
const (
	maxProjects  = 64
	maxEditors   = 200
	maxTerminals = 32
	maxExpanded  = 2000
)

// State is one saved workspace: the window-wide settings, plus a record per
// project of what that project's panes were showing.
//
// The window-wide settings are fields here rather than a nested Workspace, and
// the tree's shape is fields on Project rather than a nested Tree, because this
// package is a schema and a schema pays for every type it declares — revive
// caps a package's exported structs, and the cap is the right shape of pressure
// on one: five names that each mean something on the wire beats seven where two
// exist only to indent the file.
type State struct {
	Version int `json:"version" yaml:"version"`

	// ActiveProject is the project whose workbench was on screen, by registry
	// name. A name that is no longer registered is not an error here — the
	// frontend simply finds nothing to select.
	ActiveProject string `json:"activeProject" yaml:"activeProject,omitempty"`

	// FontSize is the terminal's font size in pixels.
	FontSize int `json:"fontSize" yaml:"fontSize,omitempty"`

	// Sidebar, TerminalHeight and ClusterWidth are the three pane splits, in
	// pixels. ClusterWidth arrived with the cluster panel (#10); a session
	// written before it restores the panel's default width, which is what a
	// zero means for every size here.
	Sidebar        int `json:"sidebar" yaml:"sidebar,omitempty"`
	TerminalHeight int `json:"terminalHeight" yaml:"terminalHeight,omitempty"`
	ClusterWidth   int `json:"clusterWidth" yaml:"clusterWidth,omitempty"`

	// ChangedOnly is the tree's changed-files filter. It is window-wide rather
	// than per project because the tree treats it that way: the filter is a
	// property of how the user is working and is carried across a project
	// switch, so storing it per project would let a switch turn it off.
	ChangedOnly bool `json:"changedOnly" yaml:"changedOnly,omitempty"`

	Projects []Project `json:"projects" yaml:"projects,omitempty"`
}

// Project is one project's saved panes, keyed by its registry name.
type Project struct {
	Name string `json:"name" yaml:"name"`

	// Editors are the open editor tabs in strip order.
	Editors []Editor `json:"editors" yaml:"editors,omitempty"`

	// ActiveEditor is the focused tab's path. A tab is identified by its file
	// because that is what a tab IS — the same path reopens the same tab
	// whatever order the strip ended up in.
	ActiveEditor string `json:"activeEditor" yaml:"activeEditor,omitempty"`

	// Terminals are the open terminal tabs in strip order.
	Terminals []Terminal `json:"terminals" yaml:"terminals,omitempty"`

	// ActiveTerminal is the focused terminal's position in that order. Unlike
	// an editor tab, a terminal has no identity beyond where it sits: its title
	// is a label the user may have set to the same thing twice, and the shell
	// behind it does not survive the app closing.
	ActiveTerminal int `json:"activeTerminal" yaml:"activeTerminal,omitempty"`

	// TreeExpanded holds the tree's open directories, root-relative. The
	// project root is an empty string in that convention, so an empty entry is
	// meaningful here and is not dropped.
	TreeExpanded []string `json:"treeExpanded" yaml:"treeExpanded,omitempty"`

	// TreeSelected is the highlighted row, or empty for none.
	TreeSelected string `json:"treeSelected" yaml:"treeSelected,omitempty"`

	// TreeShowHidden is the tree's dotfile filter, which is per project.
	TreeShowHidden bool `json:"treeShowHidden" yaml:"treeShowHidden,omitempty"`
}

// Editor is one open file.
type Editor struct {
	// Path is root-relative and slash-separated, as the frontend's tree
	// convention has it — not absolute, so a project whose checkout moves
	// restores against wherever the registry now says it is.
	Path string `json:"path" yaml:"path"`

	// Mode is the tab's view mode. It is carried as the frontend's own string
	// rather than an enumeration here: this package stores what the editor
	// said, and the editor is what knows which modes exist.
	Mode string `json:"mode" yaml:"mode,omitempty"`
}

// Terminal is one terminal tab. The shell is not saved and cannot be — a PTY
// does not outlive the app — so what comes back is the tab: its label, and the
// directory it was started in.
type Terminal struct {
	Title string `json:"title" yaml:"title"`

	// Cwd is the absolute directory the shell was started in, or empty when
	// that directory no longer exists. Empty is a value the frontend acts on
	// rather than a hole: it opens the restored tab at the project root, which
	// is the only other place it could sensibly be.
	Cwd string `json:"cwd" yaml:"cwd,omitempty"`
}

// normalize returns state with everything this package is in a position to
// check made true: the version stamped, the structural caps applied, and every
// reference that names something absent either repaired or dropped.
//
// It runs on the way in and on the way out. On the way in because the file may
// have been edited by hand or written by a build that is not this one; on the
// way out because the frontend is not a trusted producer either — a bug that
// sent a duplicated tab list would otherwise persist, and be read back as
// truth on the next launch.
func normalize(state State) State {
	state.Version = Version
	state.Projects = normalizeProjects(state.Projects)
	return state
}

// normalizeProjects caps the record count and drops the entries that could not
// be restored: an unnamed project, and a second record for a name already seen.
func normalizeProjects(projects []Project) []Project {
	if len(projects) > maxProjects {
		projects = projects[:maxProjects]
	}
	seen := make(map[string]bool, len(projects))
	kept := make([]Project, 0, len(projects))
	for _, p := range projects {
		if p.Name == "" || seen[p.Name] {
			continue
		}
		seen[p.Name] = true
		kept = append(kept, normalizeProject(p))
	}
	if len(kept) == 0 {
		return nil
	}
	return kept
}

// normalizeProject applies the per-project caps and re-points the two
// selections at something that exists.
func normalizeProject(p Project) Project {
	p.Editors = normalizeEditors(p.Editors)
	p.ActiveEditor = activeEditor(p.Editors, p.ActiveEditor)
	p.Terminals = normalizeTerminals(p.Terminals)
	p.ActiveTerminal = clampIndex(p.ActiveTerminal, len(p.Terminals))
	p.TreeExpanded = uniqueStrings(p.TreeExpanded, maxExpanded)
	return p
}

// normalizeEditors caps the strip and drops the tabs that name no file, along
// with a second tab for a file already open — the editor opens one tab per
// path, so a duplicate is a record that could not have been produced by using
// the app.
func normalizeEditors(editors []Editor) []Editor {
	if len(editors) > maxEditors {
		editors = editors[:maxEditors]
	}
	seen := make(map[string]bool, len(editors))
	kept := make([]Editor, 0, len(editors))
	for _, e := range editors {
		if e.Path == "" || seen[e.Path] {
			continue
		}
		seen[e.Path] = true
		kept = append(kept, e)
	}
	if len(kept) == 0 {
		return nil
	}
	return kept
}

// activeEditor keeps the recorded selection only when it still names an open
// tab. Empty means "no selection recorded", which the frontend answers by
// focusing the first restored tab.
func activeEditor(editors []Editor, active string) string {
	for _, e := range editors {
		if e.Path == active {
			return active
		}
	}
	return ""
}

// normalizeTerminals caps the strip and resolves each tab's directory. A cwd
// that is no longer a directory is cleared rather than the tab being dropped:
// the shell is gone either way, and a tab the user arranged is worth keeping at
// the project root — which is the substitution the frontend makes for an empty
// cwd, because it is the one that knows what the root is.
func normalizeTerminals(terminals []Terminal) []Terminal {
	if len(terminals) > maxTerminals {
		terminals = terminals[:maxTerminals]
	}
	if len(terminals) == 0 {
		return nil
	}
	kept := make([]Terminal, 0, len(terminals))
	for _, t := range terminals {
		t.Cwd = existingDir(t.Cwd)
		kept = append(kept, t)
	}
	return kept
}

// clampIndex holds an index inside a slice of the given length, answering 0 for
// an empty one — which the frontend reads as "nothing to select" because there
// is nothing there to select.
func clampIndex(index, length int) int {
	if index < 0 || index >= length {
		return 0
	}
	return index
}

// uniqueStrings returns values with repeats removed and the result capped,
// preserving order. The empty string is a value here, not a blank: the tree's
// convention names a project's own root that way.
func uniqueStrings(values []string, limit int) []string {
	if len(values) > limit {
		values = values[:limit]
	}
	seen := make(map[string]bool, len(values))
	kept := make([]string, 0, len(values))
	for _, v := range values {
		if seen[v] {
			continue
		}
		seen[v] = true
		kept = append(kept, v)
	}
	if len(kept) == 0 {
		return nil
	}
	return kept
}
