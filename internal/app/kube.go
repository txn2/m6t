package app

import (
	"context"
	"errors"
	"fmt"
	"path"

	"github.com/txn2/m6t/internal/kubeconfig"
	"github.com/txn2/m6t/internal/kubeexec"
	"github.com/txn2/m6t/internal/kubewatch"
	"github.com/txn2/m6t/internal/manifest"
	"github.com/txn2/m6t/internal/project"
	"github.com/txn2/m6t/internal/stream"
	"github.com/txn2/m6t/internal/tools"
	"github.com/txn2/m6t/internal/watch"
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
	return resolveBinding(a.projects, name, rel)
}

// resolveBinding is what KubeBinding answers with, as a function rather than a
// method.
//
// The pipeline resolves its own target and must do it exactly the way the panel
// does, so the two share this rather than one calling the other: `aim` is a free
// function for the reason tree.go's startRegisteredWatchers gives — the method
// ceiling is for bound API, not for internal wiring — and a free function cannot
// reach a method.
func resolveBinding(registry *project.Registry, name, rel string) (project.Binding, error) {
	settings, err := registry.Settings(name)
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

// The bound half of the diff → apply pipeline (DESIGN.md §6.1, issue #11).
//
// Five bindings, one per step the user drives: validate, diff, apply, and the
// delete pair. Step 3 — confirm — has no binding of its own, and that absence is
// the design rather than an omission. A confirmation is a dialog; what crosses
// the bridge is the answer to it, as the context name the user typed, on the
// call it authorizes. A separate `KubeConfirm` would be a token minted by one
// call and spent by another, which is a session to keep and to expire, to
// protect a decision that is already an argument.
//
// What this half enforces, and the one thing here that is behavior rather than
// delegation: a protected binding refuses to mutate unless the typed context
// matches exactly, before any process exists. The dialog is the UI's; the
// refusal is not, because a guard that lives only in a dialog is a guard that a
// second caller — a keyboard shortcut, a context menu, whatever #14 adds — gets
// to forget about.
//
// It shares kube.go with the binding half rather than taking a file of its own,
// which is what the package's file ceiling asks for and also what it is: the
// same service's bound surface, aimed by the same registry resolution.
//
// Every one of them resolves its own target from the registry, exactly as
// KubeCheck does and for the same reason: the binding a call is aimed with comes
// from projects.yaml at the moment of the call, never from a frontend that may
// have been rendered before the user edited it by hand.

// errNotConfirmed reports a mutation on a protected binding that arrived without
// the context name typed, or with the wrong one.
//
// It is unexported because nothing matches it: the frontend reads the message
// over the bridge, and inside Go this package is the only caller. Exporting it
// would widen the binding layer's seam for an audience of one test.
var errNotConfirmed = errors.New("this binding is protected: type the context name exactly to confirm")

// KubeValidate is step 1: `kubectl apply --dry-run=server` against the target.
//
// target is repository-relative — a file or a directory — and it is both what is
// acted on and what the binding is resolved at. Those being the same path is the
// point: a validation aimed at one cluster and an apply aimed at another would
// be two different questions, and passing the scope separately is how they would
// come to differ.
//
// A schema failure, a missing CRD, an admission refusal and an RBAC denial all
// come back as a Result with kubectl's stderr in it, which is what the UI blocks
// the pipeline on. An error here means no verdict was produced at all.
func (a *App) KubeValidate(name, target string) (kubeexec.Result, error) {
	at, err := aim(a.projects, name, target)
	if err != nil {
		return kubeexec.Result{}, err
	}
	result, err := a.kube.Validate(
		context.Background(), at.where(), at.path, at.dir, at.binding.ServerSide)
	if err != nil {
		return kubeexec.Result{}, fmt.Errorf("validating %s in %s: %w", target, name, err)
	}
	return result, nil
}

// KubeDiff is step 2: what the cluster would change if this were applied.
//
// The exit code carries the answer — 0 is "no changes", which DESIGN.md §6.1
// makes a first-class result rather than an empty screen — and it reaches the
// frontend on the Result untouched. Nothing here reads the diff kubectl printed.
func (a *App) KubeDiff(name, target string) (kubeexec.Result, error) {
	at, err := aim(a.projects, name, target)
	if err != nil {
		return kubeexec.Result{}, err
	}
	result, err := a.kube.Diff(
		context.Background(), at.where(), at.path, at.dir, at.binding.ServerSide)
	if err != nil {
		return kubeexec.Result{}, fmt.Errorf("diffing %s in %s: %w", target, name, err)
	}
	return result, nil
}

// KubeApply is step 4, and the first call in this file that changes a cluster.
//
// typed is what the user entered into the confirm dialog. It is required to
// equal the resolved context exactly when the binding is protected, and it is
// ignored when it is not — which is DESIGN.md §6.1's rule, held here rather than
// in the dialog that collects it.
//
// The check is against the RESOLVED context and not the project's default. In
// the layout scopes exist for, a file under `prod/` is protected by a rule three
// directories up and targets a context the project as a whole does not; a check
// against the default would ask for the wrong word and accept it.
func (a *App) KubeApply(name, target, typed string) (kubeexec.Result, error) {
	at, err := aim(a.projects, name, target)
	if err != nil {
		return kubeexec.Result{}, err
	}
	if err := confirm(at.binding, typed); err != nil {
		return kubeexec.Result{}, fmt.Errorf("applying %s in %s: %w", target, name, err)
	}
	result, err := a.kube.Apply(
		context.Background(), at.where(), at.path, at.dir, at.binding.ServerSide)
	if err != nil {
		return kubeexec.Result{}, fmt.Errorf("applying %s in %s: %w", target, name, err)
	}
	return result, nil
}

// KubeDeletePreview lists the objects a delete would remove, removing none.
//
// It takes no confirmation because it changes nothing, and it is a separate
// binding from KubeDelete rather than a flag on it for exactly that reason: a
// dry-run boolean is one inverted condition away from being a deletion, and the
// inversion would be in the caller this file cannot see.
func (a *App) KubeDeletePreview(name, target string) (kubeexec.Result, error) {
	at, err := aim(a.projects, name, target)
	if err != nil {
		return kubeexec.Result{}, err
	}
	result, err := a.kube.DeletePreview(context.Background(), at.where(), at.path, at.dir)
	if err != nil {
		return kubeexec.Result{}, fmt.Errorf("previewing the delete of %s in %s: %w", target, name, err)
	}
	return result, nil
}

// KubeDelete removes the objects the manifests name, under the same typed
// confirmation KubeApply requires.
func (a *App) KubeDelete(name, target, typed string) (kubeexec.Result, error) {
	at, err := aim(a.projects, name, target)
	if err != nil {
		return kubeexec.Result{}, err
	}
	if err := confirm(at.binding, typed); err != nil {
		return kubeexec.Result{}, fmt.Errorf("deleting %s in %s: %w", target, name, err)
	}
	result, err := a.kube.Delete(context.Background(), at.where(), at.path, at.dir)
	if err != nil {
		return kubeexec.Result{}, fmt.Errorf("deleting %s in %s: %w", target, name, err)
	}
	return result, nil
}

// aimed is one resolved pipeline target: which cluster, which path on disk, and
// what kind of thing the path is.
type aimed struct {
	binding project.Binding
	path    string
	dir     bool
}

// where maps the registry's resolved binding onto the one kubeexec declares.
//
// The two types stay separate on purpose (see kubeexec's package comment):
// sibling services do not import each other, so the mapping is the binding
// layer's, and it is written once here rather than at five call sites.
func (t aimed) where() kubeexec.Binding {
	return kubeexec.Binding{Context: t.binding.Context, Namespace: t.binding.Namespace}
}

// aim resolves a project name and a repository-relative path into everything an
// invocation needs, refusing anything that does not name a place inside the
// worktree.
//
// One function for all five bindings, because the two halves it does are the two
// that must never be done differently: the binding comes from the registry, and
// the path is confined before it leaves the process. A binding that resolved its
// own target would be a fifth chance to get one of those wrong.
//
// A free function over the registry handle rather than an App method, for the
// reason startRegisteredWatchers gives in tree.go: the method ceiling is a
// budget on bound API, and this is wiring.
func aim(registry *project.Registry, name, target string) (aimed, error) {
	root, err := projectPath(registry, name)
	if err != nil {
		return aimed{}, err
	}

	binding, err := resolveBinding(registry, name, target)
	if err != nil {
		return aimed{}, err
	}

	path, isDir, err := watch.Resolve(root, target)
	if err != nil {
		return aimed{}, fmt.Errorf("resolving %s in %s: %w", target, name, err)
	}
	return aimed{binding: binding, path: path, dir: isDir}, nil
}

// confirm is the protected-binding gate: the one condition standing between a
// bound method and a cluster mutation.
//
// The comparison is exact — no trimming, no case folding. A context name is a
// key the user copied off the panel in front of them, and a match that accepted
// "  Prod-US-West " would be a match that accepts a user who read the name
// approximately, which is the user this check exists for.
func confirm(binding project.Binding, typed string) error {
	if !binding.Protected {
		return nil
	}
	if typed != binding.Context {
		return errNotConfirmed
	}
	return nil
}

// projectPath returns the worktree of the named project.
//
// A free function over the registry handle rather than an App method, for the
// reason startRegisteredWatchers gives in tree.go: the method ceiling is for
// bound API, and this is a lookup.
func projectPath(registry *project.Registry, name string) (string, error) {
	projects, err := registry.List()
	if err != nil {
		return "", fmt.Errorf("finding %s: %w", name, err)
	}
	for _, p := range projects {
		if p.Name == name {
			return p.Path, nil
		}
	}
	return "", fmt.Errorf("finding %s: %w", name, project.ErrNotFound)
}

// KubeHealth reports the live state of the objects that go to whatever rel
// resolves to, putting them under watch if they are not already (#12,
// DESIGN.md §5).
//
// rel is repository-relative and may be "" for the project as a whole, exactly
// as KubeBinding's is — the panel asks both questions about the same selection,
// and a health section aimed at a different place from the binding section
// above it would be a panel disagreeing with itself.
//
// What it answers for is every object in the checkout that resolves to THAT
// binding, not every object under that directory. The two differ in the layout
// folder overrides exist for: at the root of a repository whose `prod/` tree
// points elsewhere, the root's answer covers everything except `prod/`, and
// selecting `prod/` covers `prod/`. Between them they partition the project with
// nothing counted twice and nothing left out, and neither is ever a row shown
// against a cluster it does not live in.
//
// Asking is what starts the watch. There is no separate start binding, for the
// reason internal/watch's Start is idempotent: the frontend's two questions are
// "show me this project" and "something changed, ask again", and a start call
// the second one had to skip would be a state machine on the frontend to
// protect a map lookup on the backend.
func (a *App) KubeHealth(name, rel string) (kubewatch.Snapshot, error) {
	root, err := projectPath(a.projects, name)
	if err != nil {
		return kubewatch.Snapshot{}, err
	}

	binding, err := resolveBinding(a.projects, name, rel)
	if err != nil {
		return kubewatch.Snapshot{}, err
	}

	return a.watches.Watch(root, binding.Context, binding.Namespace), nil
}

// manifestBridge presents the manifest indexer and the project registry
// together through the seam internal/kubewatch declares.
//
// The two are joined here because this is the only layer that knows both exist,
// which is the same argument watchBridge makes. The indexer knows which file
// declares what and nothing about clusters; the registry knows which folder
// points where and nothing about manifests; the watch service needs the objects
// belonging to one binding, and that is the intersection.
type manifestBridge struct {
	projects *project.Registry
}

// Declared indexes a checkout and keeps the objects that resolve to the given
// binding.
//
// Filtering here rather than in internal/kubewatch is what keeps the scope
// rules in one place. A manifest under a folder carrying an override belongs to
// that folder's cluster, and `project.Kube.Resolve` is the function that decides
// so — for the panel, for the status bar, and for every kubectl invocation the
// pipeline makes. A second implementation of that rule inside the watch service
// would be a second answer to "where does this go", which is the one question
// this application cannot afford two answers to.
func (b manifestBridge) Declared(root, target, namespace string) ([]kubewatch.Object, []kubewatch.Notice, error) {
	binding, err := b.bindingAt(root)
	if err != nil {
		return nil, nil, err
	}

	index, err := manifest.Scan(root)
	if err != nil {
		return nil, nil, fmt.Errorf("indexing %s: %w", root, err)
	}

	objects := make([]kubewatch.Object, 0, len(index.Objects))
	for _, declared := range index.Objects {
		// The folder the manifest sits in, which is what a scope is written
		// against — a file inherits from its directory, the same reduction the
		// panel's selection makes.
		at := binding.Resolve(path.Dir(declared.File))
		if at.Context != target || at.Namespace != namespace {
			continue
		}
		objects = append(objects, kubewatch.Object{
			APIVersion: declared.APIVersion,
			Kind:       declared.Kind,
			Namespace:  declared.Namespace,
			Name:       declared.Name,
			File:       declared.File,
		})
	}

	return objects, notices(index.Notices), nil
}

// bindingAt finds the kube settings of the project checked out at root.
//
// By path rather than by name because that is what a watch session is keyed on:
// the session outlives the call that started it, and a project renamed in the
// meantime would otherwise take its own health down.
func (b manifestBridge) bindingAt(root string) (project.Kube, error) {
	projects, err := b.projects.List()
	if err != nil {
		return project.Kube{}, fmt.Errorf("finding the project at %s: %w", root, err)
	}
	for _, p := range projects {
		if p.Path == root {
			return p.Kube, nil
		}
	}
	return project.Kube{}, fmt.Errorf("finding the project at %s: %w", root, project.ErrNotFound)
}

// notices maps the indexer's notices onto the watch service's own type. The two
// are separate because the services are siblings (DESIGN.md §3.2), and this is
// the one place that imports both.
func notices(from []manifest.Notice) []kubewatch.Notice {
	out := make([]kubewatch.Notice, 0, len(from))
	for _, n := range from {
		out = append(out, kubewatch.Notice{File: n.File, Reason: n.Reason})
	}
	return out
}

// healthBridge presents the loopback stream server through the seam
// internal/kubewatch declares, the shape watchBridge and terminalBridge already
// take for their services.
type healthBridge struct {
	streams *stream.Server
}

// PublishHealthChanged forwards a session's announcement onto the /events
// channel (PROTOCOL.md §5).
func (b healthBridge) PublishHealthChanged(root string) {
	b.streams.PublishHealth(root)
}
