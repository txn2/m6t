// Package project holds the project registry: the persistent list of manifest
// repositories m6t works with, and the per-project settings that later services
// bind to (DESIGN.md §4).
//
// The registry is the app's organizing unit — a project is what a tab, a file
// tree, a terminal's working directory and a kube context all hang off. It
// imports nothing first-party: like the PTY and stream services it is composed
// by internal/app rather than reaching for it.
//
// Nothing is ever written into a managed repository. The registry records where
// a repo is; the repo itself stays a pristine manifest checkout.
package project

import "strings"

// Kube is a project's cluster binding.
//
// The binding is per project and explicit: m6t never falls back to the
// kubeconfig current-context, because "whatever kubectl would have done" is how
// a manifest lands in the wrong cluster.
//
// The three scalar fields are the project's default, and Scopes overrides them
// per subtree. That split is the shape of a real manifest repository: a
// directory per cluster, a directory per namespace beneath it, and one project
// that has to target both without the user rebinding it between applies. See
// Scope and Kube.Resolve in binding.go — nothing outside this package reads
// these fields directly, because reading Context for a path that a scope
// overrides is exactly how the wrong cluster gets targeted.
type Kube struct {
	// Context is the kubeconfig context name for the project as a whole.
	// Empty means unbound.
	Context string `yaml:"context,omitempty" json:"context"`

	// Namespace is the default namespace for actions in this project.
	Namespace string `yaml:"namespace,omitempty" json:"namespace"`

	// Protected requires typed confirmation on apply, delete and rollback.
	Protected bool `yaml:"protected,omitempty" json:"protected"`

	// ServerSide selects server-side apply for this project (DESIGN.md §6.1).
	//
	// It is a project-wide setting with no per-scope override, unlike the three
	// fields above, and that asymmetry is deliberate: context and namespace say
	// WHERE a manifest goes and differ per subtree by design, while this says
	// HOW every apply in the repository is performed. A repository whose `dev/`
	// tree applied client-side and whose `prod/` tree applied server-side would
	// have two field-manager histories for the same objects, which is a
	// conflict the user gets to discover during a production apply.
	ServerSide bool `yaml:"serverSide,omitempty" json:"serverSide"`

	// Scopes are per-subtree overrides, deepest match winning per field.
	Scopes []Scope `yaml:"scopes,omitempty" json:"scopes"`
}

// Helm is a project's Helm defaults.
type Helm struct {
	// DefaultValues lists values files applied to renders in this project, in
	// order, later files overriding earlier ones.
	DefaultValues []string `yaml:"defaultValues,omitempty" json:"defaultValues"`
}

// Settings is the mutable part of a project: everything except its identity.
//
// It is a separate type from Project so that updating a binding cannot rename a
// project or move it on disk. Name is how every other record refers to a
// project and Path is where the repo actually is — neither is a setting, and an
// update call that could change them would be a rename and a relocation wearing
// the same name as editing a namespace.
//
// DisplayName is what makes that split survive the tab strip being renameable
// (#41). Almost every manifest repository is checked out as "k8s", so the
// directory name is a bad identity to show a user — but re-keying the registry
// on every rename would invalidate the name that terminals, editor tabs and
// watchers are all filed under. The label is a setting; the key is not.
type Settings struct {
	// DisplayName is the label the project tab shows. Empty means the project
	// is shown under its Name, which is what every registry written before
	// this field existed holds.
	DisplayName string `yaml:"displayName,omitempty" json:"displayName"`

	// Color is the tab's accent, by palette name rather than by value. The
	// registry does not know the palette: the names come from the UI and are
	// resolved there, so a color this build has no entry for renders as no
	// color instead of as a value injected into a stylesheet.
	Color string `yaml:"color,omitempty" json:"color"`

	Kube Kube `yaml:"kube,omitempty" json:"kube"`
	Helm Helm `yaml:"helm,omitempty" json:"helm"`
}

// Project is one registered manifest repository.
type Project struct {
	// Name identifies the project. It is unique within the registry and is the
	// key every operation here takes.
	Name string `yaml:"name" json:"name"`

	// Path is the absolute path to the repository's working tree. It is stored
	// tilde-abbreviated when it lies under the user's home directory, so a
	// projects.yaml stays readable and survives a home directory that moves.
	Path string `yaml:"path" json:"path"`

	// ShortPath is Path as the file holds it: tilde-abbreviated when the
	// checkout lies under the user's home directory.
	//
	// It is never stored — `yaml:"-"` — because it is derived from Path and a
	// second copy in the file would be one more thing that can disagree with
	// it. It exists because the two audiences want opposite forms: every
	// caller acting on the repository needs the absolute path, and the one
	// place that shows it to a user wants the short one, and a frontend has no
	// way to work out where home is.
	ShortPath string `yaml:"-" json:"shortPath"`

	DisplayName string `yaml:"displayName,omitempty" json:"displayName"`
	Color       string `yaml:"color,omitempty" json:"color"`

	Kube Kube `yaml:"kube,omitempty" json:"kube"`
	Helm Helm `yaml:"helm,omitempty" json:"helm"`
}

// settings returns the project's mutable half.
func (p Project) settings() Settings {
	return Settings{DisplayName: p.DisplayName, Color: p.Color, Kube: p.Kube, Helm: p.Helm}
}

// withSettings returns a copy of the project carrying s, leaving identity
// untouched.
func (p Project) withSettings(s Settings) Project {
	p.DisplayName = strings.TrimSpace(s.DisplayName)
	p.Color = strings.TrimSpace(s.Color)
	p.Kube = s.Kube
	p.Helm = s.Helm
	return p
}

// document is the on-disk shape of projects.yaml.
//
// It wraps the slice in a named field rather than marshaling a bare list
// because the file is the app's configuration and will gain sibling keys;
// a top-level list would have to be migrated the first time one arrives.
type document struct {
	Projects []Project `yaml:"projects"`
}
