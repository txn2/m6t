package app

import (
	"fmt"

	"github.com/txn2/m6t/internal/session"
)

// SessionState reports the workspace as it stood when m6t was last closed
// (#58): which project was open, what each project's editor, tree and terminal
// panes were showing, and the window-wide settings around them.
//
// It returns no error because internal/session answers every failure the same
// way — with the zero session — and there is nothing else a launch could do
// with one. A file that does not parse means the user gets the defaults, not a
// dialog about a file they did not know they had.
func (a *App) SessionState() session.State {
	return a.sessions.Load()
}

// SaveSession records the workspace the frontend describes.
//
// The whole state arrives in one call rather than a setter per field, which is
// what keeps this a two-method surface while the workspace grows: a control
// added to the UI joins the record the frontend already sends, instead of
// widening the bridge. The frontend debounces, so this runs once per pause in
// the user's activity rather than once per keystroke or drag frame.
func (a *App) SaveSession(state session.State) error {
	if err := a.sessions.Save(state); err != nil {
		return fmt.Errorf("saving the session: %w", err)
	}
	return nil
}
