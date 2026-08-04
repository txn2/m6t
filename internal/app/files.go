package app

import (
	"fmt"

	"github.com/txn2/m6t/internal/watch"
)

// ReadFile returns a file's content from a project's worktree (DESIGN.md
// §5's editor). root is the project's own path, the same convention every
// other binding in this package uses.
func (*App) ReadFile(root, relPath string) (watch.FileContent, error) {
	content, err := watch.ReadFile(root, relPath)
	if err != nil {
		return watch.FileContent{}, fmt.Errorf("reading %s in %s: %w", relPath, root, err)
	}
	return content, nil
}

// WriteFile saves a file's content to a project's worktree, preserving its
// original line-ending style (crlf, as ReadFile reported it) so a save shows
// up as exactly the edit in `git diff` — the issue's own acceptance
// criterion.
func (*App) WriteFile(root, relPath, content string, crlf bool) error {
	if err := watch.WriteFile(root, relPath, content, crlf); err != nil {
		return fmt.Errorf("writing %s in %s: %w", relPath, root, err)
	}
	return nil
}
