package app

import (
	"errors"
	"fmt"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/txn2/m6t/internal/project"
)

// chooseTitle is what the directory picker's window says it is for.
const chooseTitle = "Choose a repository"

// errNoWindow reports a dialog asked for before the Wails runtime is up.
var errNoWindow = errors.New("the application window is not ready")

// Projects lists the registered projects, in the order the user arranged them.
func (a *App) Projects() ([]project.Project, error) {
	projects, err := a.projects.List()
	if err != nil {
		return nil, fmt.Errorf("listing projects: %w", err)
	}
	return projects, nil
}

// ChooseProjectDirectory opens the OS directory picker and returns what the
// user chose, or "" if they canceled.
//
// The picker is the native one rather than a path typed into the UI: choosing a
// checkout is a filesystem browse, and a text field makes the user do the
// browsing somewhere else and paste the result. Canceling is an empty string
// and not an error — the user declining is an ordinary outcome, and a caller
// that treated it as a failure would show an error box for a dismissed dialog.
//
// It only reports where the user pointed. Validating that the directory is a
// git worktree is AddProject's job, so the two stay independently usable and
// the picker does not need to know what a project is.
func (a *App) ChooseProjectDirectory() (string, error) {
	window := a.window.Load()
	if window == nil {
		return "", errNoWindow
	}
	dir, err := wailsruntime.OpenDirectoryDialog(*window, wailsruntime.OpenDialogOptions{
		Title: chooseTitle,
	})
	if err != nil {
		return "", fmt.Errorf("choosing a directory: %w", err)
	}
	return dir, nil
}

// AddProject registers an existing checkout under the label name.
//
// The label arrives with the registration rather than in a follow-up call
// because a project whose tab flashed its directory name before the rename
// landed would be the exact problem the label exists to solve. A blank name
// means the project is shown under its registry name.
func (a *App) AddProject(path, name string) (project.Project, error) {
	added, err := a.projects.Add(path, name)
	if err != nil {
		return project.Project{}, fmt.Errorf("adding project at %s: %w", path, err)
	}

	// Best effort, like streams.Start at OnStartup: a watcher that fails to
	// start must not stop the project from being usable — List, Create,
	// Rename and Delete all work without it, and the tree simply will not
	// self-update until the watcher does start.
	_ = a.trees.Start(added.Path)

	return added, nil
}

// RemoveProject drops a project from the registry, leaving its working tree on
// disk untouched.
func (a *App) RemoveProject(name string) error {
	removed, err := a.projects.Remove(name)
	if err != nil {
		return fmt.Errorf("removing project %s: %w", name, err)
	}
	a.trees.Stop(removed.Path)
	return nil
}

// ReorderProjects rewrites the project order to the one the tab strip now
// shows, and returns the registry as it stands afterwards.
//
// It returns the list rather than nothing so the strip does not have to re-read
// what it just told the backend: a drag that ended in a reload would repaint
// the tabs a frame after they settled.
func (a *App) ReorderProjects(names []string) ([]project.Project, error) {
	ordered, err := a.projects.Reorder(names)
	if err != nil {
		return nil, fmt.Errorf("reordering projects: %w", err)
	}
	return ordered, nil
}

// UpdateProject replaces a project's label, color, kube binding and helm
// defaults.
//
// There is no matching getter bound: Projects already returns every project's
// settings, so a ProjectSettings binding would be a second way to read what the
// frontend has in hand — surface with no caller, which is the no-vaporware rule
// applied to the bridge.
func (a *App) UpdateProject(name string, settings project.Settings) (project.Project, error) {
	updated, err := a.projects.Update(name, settings)
	if err != nil {
		return project.Project{}, fmt.Errorf("updating project %s: %w", name, err)
	}
	return updated, nil
}
