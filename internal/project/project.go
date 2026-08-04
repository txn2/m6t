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

// Kube is a project's cluster binding.
//
// The binding is per project and explicit: m6t never falls back to the
// kubeconfig current-context, because "whatever kubectl would have done" is how
// a manifest lands in the wrong cluster. The fields exist now and the UI that
// sets them arrives with the kube exec service (#10); until then a project
// carries a zero binding and the cluster panel stays disabled.
type Kube struct {
	// Context is the kubeconfig context name. Empty means unbound.
	Context string `yaml:"context,omitempty" json:"context"`

	// Namespace is the default namespace for actions in this project.
	Namespace string `yaml:"namespace,omitempty" json:"namespace"`

	// Protected requires typed confirmation on apply, delete and rollback.
	Protected bool `yaml:"protected,omitempty" json:"protected"`
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
type Settings struct {
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

	Kube Kube `yaml:"kube,omitempty" json:"kube"`
	Helm Helm `yaml:"helm,omitempty" json:"helm"`
}

// settings returns the project's mutable half.
func (p Project) settings() Settings {
	return Settings{Kube: p.Kube, Helm: p.Helm}
}

// withSettings returns a copy of the project carrying s, leaving identity
// untouched.
func (p Project) withSettings(s Settings) Project {
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
