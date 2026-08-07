package project

import (
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"
)

// separator is the one path separator a scope path is written with. Scopes are
// stored slash-form regardless of platform, because a projects.yaml written on
// a Mac has to resolve the same on Windows.
const separator = "/"

// ErrInvalidScope reports a scope path that does not name a place inside the
// repository.
var ErrInvalidScope = errors.New("a scope path must be a relative path inside the repository")

// Scope overrides part of a project's binding for one subtree of its repository.
//
// It exists because the ordinary layout of a manifest repository is one
// directory per cluster and one directory beneath it per namespace, and a
// single project-wide binding cannot describe that: it would make `dev/` and
// `prod/` the same target, which is precisely the mistake the binding exists to
// prevent. A scope says "everything under this path goes somewhere else".
//
// The three fields are independent. An unset field is not "override with
// empty", it is "inherit" — which is what makes the common case where dev and
// prod share a cluster and differ only in namespace expressible as a scope that
// sets Namespace and says nothing about Context.
type Scope struct {
	// Path is the subtree, relative to the repository root, in slash form.
	// The empty path is the root and is equivalent to setting the project
	// defaults, so the UI does not offer it.
	Path string `yaml:"path" json:"path"`

	// Context is the kubeconfig context for this subtree, or "" to inherit.
	Context string `yaml:"context,omitempty" json:"context"`

	// Namespace is the namespace for this subtree, or "" to inherit.
	Namespace string `yaml:"namespace,omitempty" json:"namespace"`

	// Protected turns on typed confirmation for this subtree.
	//
	// It is a ratchet, not an override: a scope can require confirmation that
	// its parent did not, and no scope can take it away. A tri-state that
	// could switch protection off would let a directory five levels down
	// disarm the app's single most important safety feature (DESIGN.md §5)
	// from a config file, and the case it would serve — an unprotected
	// sandbox inside a protected tree — is better served by binding the
	// sandbox to the context it actually belongs to.
	Protected bool `yaml:"protected,omitempty" json:"protected"`
}

// overridesNothing reports a scope that leaves every field to its parent.
//
// It is only ever produced by a form saved with nothing filled in — a
// projects.yaml can hold one too, written by hand, which is why Resolve and the
// UI both still cope with it rather than assuming it cannot exist.
func (s Scope) overridesNothing() bool {
	return strings.TrimSpace(s.Context) == "" &&
		strings.TrimSpace(s.Namespace) == "" &&
		!s.Protected
}

// Binding is the resolved answer for one path: what kubectl will actually be
// told, and what decided it.
type Binding struct {
	// Context is the kubeconfig context. Empty means unbound, which is the
	// state in which no kube action runs at all (DESIGN.md §4).
	Context string `json:"context"`

	// Namespace is the namespace every invocation passes explicitly. It is
	// empty only when unset all the way up, which is treated as unbound for
	// the same reason an empty context is: kubectl with no --namespace falls
	// back to the context's own default, and an implicit target is the thing
	// this whole mechanism exists to rule out.
	Namespace string `json:"namespace"`

	// Protected requires typed confirmation on apply, delete and rollback.
	Protected bool `json:"protected"`

	// ServerSide selects server-side apply. It is carried on the resolved
	// binding rather than read from Kube directly for the reason every field
	// here is: a caller that reached into the settings for one field would be
	// a second place that decides what an invocation looks like, and there is
	// exactly one — this type.
	ServerSide bool `json:"serverSide"`

	// Scope is the path of the deepest scope that applied, or "" when the
	// answer is the project's own default. The UI shows it so a user reading
	// "prod-us-west / api" can see it came from `prod/api` and not from a
	// project default they forgot they set.
	Scope string `json:"scope"`
}

// Bound reports whether this binding can target a cluster at all.
func (b Binding) Bound() bool {
	return b.Context != "" && b.Namespace != ""
}

// Resolve returns the binding that applies to a repository-relative path.
//
// Resolution starts at the project defaults and walks the matching scopes from
// the shallowest to the deepest, each one replacing the fields it sets. Because
// two scopes can only both match a path when one is an ancestor of the other,
// ordering by path length IS ordering by depth, and the deepest match is
// therefore the last writer of every field it names.
//
// rel is cleaned first, so a caller may pass "prod/api", "./prod/api" or
// "prod/api/" and get the same answer. A path that climbs out of the repository
// resolves against the project defaults rather than against a scope: nothing
// above the root is in any subtree, and answering with the safest binding beats
// answering with an error a status bar has nowhere to put.
//
// Two scopes that clean to the same path cannot get here through the settings
// UI — validateScopes refuses them — but they can through a projects.yaml
// edited by hand, which DESIGN.md §4 supports. This resolves them by file
// order, last one winning, and it does so through a stable sort so the answer
// does not move between two reads of an unchanged file. That is the most this
// function can do about it: it returns a binding and has nowhere to put an
// error. What makes the duplicate visible is Binding.Scope, which names the
// rule that decided the answer — the panel shows it, and a user seeing a scope
// they did not expect has the thread to pull.
func (k Kube) Resolve(rel string) Binding {
	target := cleanScope(rel)

	// Cleaned once per scope rather than inside the comparator: a sort calls
	// its comparator O(n log n) times, and normalizing a path there would
	// redo the same string work on every comparison.
	type match struct {
		path  string
		scope Scope
	}
	applicable := make([]match, 0, len(k.Scopes))
	for _, scope := range k.Scopes {
		if cleaned := cleanScope(scope.Path); covers(cleaned, target) {
			applicable = append(applicable, match{path: cleaned, scope: scope})
		}
	}
	slices.SortStableFunc(applicable, func(a, b match) int {
		return len(a.path) - len(b.path)
	})

	// ServerSide is seeded from the project and never touched by the loop
	// below: it is the one field no scope overrides (see Kube.ServerSide).
	resolved := Binding{
		Context:    k.Context,
		Namespace:  k.Namespace,
		Protected:  k.Protected,
		ServerSide: k.ServerSide,
	}
	for _, applies := range applicable {
		if applies.scope.Context != "" {
			resolved.Context = applies.scope.Context
		}
		if applies.scope.Namespace != "" {
			resolved.Namespace = applies.scope.Namespace
		}
		resolved.Protected = resolved.Protected || applies.scope.Protected
		resolved.Scope = applies.path
	}
	return resolved
}

// covers reports whether the subtree rooted at scope contains target.
//
// The match is on whole segments: `prod` covers `prod/api` and does not cover
// `production`. Getting that wrong is not a cosmetic bug — it is a directory
// silently inheriting a neighbour's cluster.
//
// It is also case-sensitive, which is a deliberate choice and not an oversight.
// A scope written `Dev` does not cover `dev/`, so on macOS or Windows — where
// the filesystem would treat those as one directory — a scope typed with the
// wrong case falls back to the project default instead of applying. That is the
// wrong-looking half of a trade whose other half is worse: folding case would
// make one scope cover two genuinely different directories on Linux, which is
// where these repositories are checked out by CI and where `dev/` and `Dev/`
// both existing is legal. The mistake this leaves is visible rather than
// silent — the panel names the rule that decided each answer, so a folder that
// resolves "from the project default" when the user expected a scope says so on
// screen.
func covers(scope, target string) bool {
	if scope == "" {
		return true
	}
	return target == scope || strings.HasPrefix(target, scope+separator)
}

// cleanScope normalizes a repository-relative path to the form Resolve compares.
//
// Backslashes become slashes so a scope typed on Windows matches a path the
// tree reports, and "." — what path.Clean makes of "" and "./" — becomes the
// empty root.
func cleanScope(p string) string {
	trimmed := strings.TrimSpace(strings.ReplaceAll(p, `\`, separator))
	if trimmed == "" {
		return ""
	}
	cleaned := path.Clean(trimmed)
	if cleaned == "." || cleaned == separator {
		return ""
	}
	return strings.TrimPrefix(cleaned, separator)
}

// validateScopes normalizes the scope paths in a binding and rejects the ones
// that do not name a place inside the repository.
//
// Refusal rather than repair: a scope written as "../../etc" or "/prod" is a
// user who believes they have bound a directory, and silently rewriting it to
// something else would leave them with a binding that points at a subtree they
// never named. Absolute paths and parent traversal are both refused for that
// reason, and duplicates are refused because two rules for one subtree have no
// defined winner a user could predict.
func validateScopes(k Kube) (Kube, error) {
	seen := make(map[string]bool, len(k.Scopes))
	scopes := make([]Scope, 0, len(k.Scopes))

	for _, scope := range k.Scopes {
		trimmed := strings.TrimSpace(strings.ReplaceAll(scope.Path, `\`, separator))
		if strings.HasPrefix(trimmed, separator) || escapes(trimmed) {
			return Kube{}, fmt.Errorf("scope %q: %w", scope.Path, ErrInvalidScope)
		}

		cleaned := cleanScope(trimmed)
		if cleaned == "" {
			return Kube{}, fmt.Errorf("scope %q: %w", scope.Path, ErrInvalidScope)
		}
		if seen[cleaned] {
			return Kube{}, fmt.Errorf("scope %q is set twice: %w", cleaned, ErrInvalidScope)
		}
		seen[cleaned] = true

		scope.Path = cleaned
		scope.Context = strings.TrimSpace(scope.Context)
		scope.Namespace = strings.TrimSpace(scope.Namespace)
		scopes = append(scopes, scope)
	}

	if len(scopes) == 0 {
		// nil rather than an empty slice: `omitempty` drops a nil and keeps a
		// zero-length one, and a projects.yaml that grew `scopes: []` the
		// first time a user opened the settings dialog would be a file the app
		// edited for no reason.
		k.Scopes = nil
		return k, nil
	}
	k.Scopes = scopes
	return k, nil
}

// escapes reports whether a cleaned relative path leaves the directory it is
// relative to.
func escapes(p string) bool {
	cleaned := path.Clean(p)
	return cleaned == ".." || strings.HasPrefix(cleaned, ".."+separator)
}

// BindScope sets the folder override at scope.Path, replacing whatever was
// there, and returns the project as it stands afterwards.
//
// It is a registry operation rather than a read-modify-write in the caller
// because projects.yaml is editable by hand while m6t is running (DESIGN.md
// §4): a UI that read the scopes, changed one and wrote the list back would
// erase whatever arrived in between. Here the whole cycle happens under the
// same mutex as every other write.
//
// A scope that overrides nothing — no context, no namespace, no protection —
// removes the folder's override rather than storing an empty one. The form
// that produces it says "inherit everything", and "inherit everything" is what
// having no override means; storing it instead would leave the tree marking a
// folder as bound while it resolved exactly as its parent does, which is the
// binding lying about itself.
func (r *Registry) BindScope(name string, scope Scope) (Project, error) {
	if scope.overridesNothing() {
		return r.UnbindScope(name, scope.Path)
	}
	return r.rewriteScopes(name, func(scopes []Scope) []Scope {
		replaced := make([]Scope, 0, len(scopes)+1)
		for _, existing := range scopes {
			if cleanScope(existing.Path) != cleanScope(scope.Path) {
				replaced = append(replaced, existing)
			}
		}
		return append(replaced, scope)
	})
}

// UnbindScope removes the folder override at path.
//
// Removing one that is not there is not an error: the dialog offers the action
// against what it last read, and a folder someone unbound in another window in
// the meantime has arrived at the state the user asked for.
func (r *Registry) UnbindScope(name, folder string) (Project, error) {
	target := cleanScope(folder)
	return r.rewriteScopes(name, func(scopes []Scope) []Scope {
		kept := make([]Scope, 0, len(scopes))
		for _, existing := range scopes {
			if cleanScope(existing.Path) != target {
				kept = append(kept, existing)
			}
		}
		return kept
	})
}

// rewriteScopes applies change to a project's scope list and stores the result,
// validated exactly as a settings write is. The caller must not hold mu.
func (r *Registry) rewriteScopes(name string, change func([]Scope) []Scope) (Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	projects, err := load(r.dir)
	if err != nil {
		return Project{}, err
	}

	for i, p := range projects {
		if p.Name != name {
			continue
		}
		kube := p.Kube
		kube.Scopes = change(kube.Scopes)
		validated, err := validateScopes(kube)
		if err != nil {
			return Project{}, fmt.Errorf("binding a folder in %s: %w", name, err)
		}

		projects[i].Kube = validated
		if err := save(r.dir, projects); err != nil {
			return Project{}, err
		}
		return resolved(projects[i]), nil
	}
	return Project{}, fmt.Errorf("binding a folder in %s: %w", name, ErrNotFound)
}
