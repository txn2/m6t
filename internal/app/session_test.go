package app

import (
	"strings"
	"testing"

	"github.com/txn2/m6t/internal/session"
)

// sessionApp builds the binding over a session store in a fresh temp
// directory. The registry is deliberately absent: these two methods reach only
// the session service, and an App that needed more wiring than that would be a
// binding doing work of its own.
func sessionApp(t *testing.T) *App {
	t.Helper()
	return &App{sessions: session.New(t.TempDir())}
}

func TestSaveSessionAndSessionStateRoundTripThroughTheBinding(t *testing.T) {
	a := sessionApp(t)

	err := a.SaveSession(session.State{
		Version:       session.Version,
		ActiveProject: "infra",
		FontSize:      15,
		Sidebar:       300,
		Projects: []session.Project{{
			Name:         "infra",
			Editors:      []session.Editor{{Path: "values.yaml", Mode: "edit"}},
			ActiveEditor: "values.yaml",
		}},
	})
	if err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	got := a.SessionState()
	if got.ActiveProject != "infra" || got.FontSize != 15 {
		t.Errorf("window settings = %q/%d, want infra/15", got.ActiveProject, got.FontSize)
	}
	if len(got.Projects) != 1 || got.Projects[0].ActiveEditor != "values.yaml" {
		t.Errorf("projects = %+v, want infra with values.yaml focused", got.Projects)
	}
}

// A launch with nothing saved yet must answer with the zero session rather
// than an error the window would have to render.
func TestSessionStateOnAFirstLaunchIsEmpty(t *testing.T) {
	got := sessionApp(t).SessionState()

	if got.Version != 0 || len(got.Projects) != 0 {
		t.Errorf("SessionState = %+v, want the zero session", got)
	}
}

// A write that cannot land is the one thing the frontend could act on, so the
// binding reports it — named, so the message says which operation failed.
func TestSaveSessionReportsAFailedWrite(t *testing.T) {
	a := &App{sessions: session.New("")}

	err := a.SaveSession(session.State{Version: session.Version})
	if err == nil {
		t.Fatal("SaveSession succeeded with no configuration directory, want an error")
	}
	if !strings.Contains(err.Error(), "saving the session") {
		t.Errorf("error = %q, want it to name the operation", err)
	}
}
