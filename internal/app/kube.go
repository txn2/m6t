package app

import (
	"context"
	"fmt"

	"github.com/txn2/m6t/internal/kubeconfig"
	"github.com/txn2/m6t/internal/kubeexec"
	"github.com/txn2/m6t/internal/project"
	"github.com/txn2/m6t/internal/tools"
)

// KubeContexts lists the contexts the user's kubeconfig offers, for the
// settings dialog to bind a project to (DESIGN.md §4).
//
// Reading them is not selecting one. Nothing here consults or honors the
// kubeconfig's current-context: it is reported as a flag on the entry so the
// dialog can hint at it, and binding stays a thing the user does on purpose.
func (*App) KubeContexts() (kubeconfig.Config, error) {
	config, err := kubeconfig.Load()
	if err != nil {
		return kubeconfig.Config{}, fmt.Errorf("listing kube contexts: %w", err)
	}
	return config, nil
}

// KubeBinding resolves what a path inside a project is actually bound to: the
// project's default, or whichever subtree scope overrides it (project.Scope).
//
// rel is repository-relative and may be "" for the project as a whole. It is
// the frontend's question every time the selection moves, because the cluster
// panel and the status bar have to name the target of the file on screen and
// not the target of the project — in a repository laid out one directory per
// cluster those are routinely different, which is the entire reason scopes
// exist.
func (a *App) KubeBinding(name, rel string) (project.Binding, error) {
	settings, err := a.projects.Settings(name)
	if err != nil {
		return project.Binding{}, fmt.Errorf("resolving the kube binding for %s: %w", name, err)
	}
	return settings.Kube.Resolve(rel), nil
}

// KubeCheck runs the smoke action against whatever rel resolves to: does this
// binding reach a cluster, and does this user authenticate to it?
//
// It resolves the binding here rather than taking one from the frontend. A
// context and namespace arriving over the bridge would be the frontend's idea
// of the binding, and the whole safety property of DESIGN.md §4 is that the
// target comes from the registry — a UI that had gone stale after an edit to
// projects.yaml could otherwise aim a call at the previous cluster.
//
// An unbound path is refused by kubeexec before a process exists, and that
// refusal reaches the frontend as an error rather than as a Result, because
// "nothing ran" and "it ran and failed" are different things for a panel to
// say.
func (a *App) KubeCheck(name, rel string) (kubeexec.Result, error) {
	binding, err := a.KubeBinding(name, rel)
	if err != nil {
		return kubeexec.Result{}, err
	}

	result, err := a.kube.Check(context.Background(), kubeexec.Binding{
		Context:   binding.Context,
		Namespace: binding.Namespace,
	})
	if err != nil {
		return kubeexec.Result{}, fmt.Errorf("checking the binding for %s: %w", name, err)
	}
	return result, nil
}

// KubeNamespaces lists the namespaces a context offers, so a binding form can
// complete its namespace field from the cluster rather than from memory.
//
// It takes a context name rather than a project because it is asked while the
// user is choosing one — the binding does not exist yet, which is the whole
// reason the form is open. That is also why it is the one kube call here that
// is not aimed by the registry: it reads a list, it acts on nothing.
//
// A failure is the caller's to shrug at. Listing namespaces is a permission a
// great many users of a shared cluster do not have, and a form that refused to
// accept a typed namespace because it could not enumerate them would be
// unusable for exactly the people most likely to be working in one namespace.
func (a *App) KubeNamespaces(target string) ([]string, error) {
	namespaces, err := a.kube.Namespaces(context.Background(), target)
	if err != nil {
		return nil, fmt.Errorf("listing namespaces in %s: %w", target, err)
	}
	return namespaces, nil
}

// BindFolder points one directory of a project at a context and namespace,
// replacing any override already on it (DESIGN.md §4).
//
// Folder bindings are made from the tree, on the folder itself, because that is
// where the user already is when they know the answer: a repository laid out
// one directory per cluster is one the user reads as a tree, and a form
// listing paths as text would make them retype what they are looking at. The
// project panel lists what exists; this is what creates one.
//
// Either half may be empty, and empty means inherit rather than unset — a
// folder that overrides only the namespace keeps the context above it, which is
// the repository whose environments share a cluster.
func (a *App) BindFolder(name, path, target, namespace string, guarded bool) (project.Project, error) {
	bound, err := a.projects.BindScope(name, project.Scope{
		Path:      path,
		Context:   target,
		Namespace: namespace,
		Protected: guarded,
	})
	if err != nil {
		return project.Project{}, fmt.Errorf("binding %s in %s: %w", path, name, err)
	}
	return bound, nil
}

// UnbindFolder removes a directory's override, returning it to whatever it
// inherits.
func (a *App) UnbindFolder(name, path string) (project.Project, error) {
	unbound, err := a.projects.UnbindScope(name, path)
	if err != nil {
		return project.Project{}, fmt.Errorf("unbinding %s in %s: %w", path, name, err)
	}
	return unbound, nil
}

// Tools reports which external binaries are installed, so the UI can disable
// what is unavailable with a sentence rather than with a failed subprocess
// (DESIGN.md §2).
//
// The Wails binding generator has no notion of an injected context, so a bound
// method taking one would export a first argument the frontend has nothing to
// pass. The deadline that matters is the per-invocation one inside each
// service; the background context here is the same choice internal/git makes
// for the same reason.
func (*App) Tools() []tools.Tool {
	return tools.Detect(context.Background())
}
