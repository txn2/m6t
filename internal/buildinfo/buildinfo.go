// Package buildinfo carries the identity stamped into the m6t binary at link
// time. It is a leaf: it imports nothing first-party so any layer can read the
// build identity without dragging a dependency along.
package buildinfo

import "strings"

// Link-time values, injected by the Makefile with -ldflags -X. They are
// deliberately unexported: Get is the only way to read them, so the
// normalization in newInfo cannot be bypassed.
var (
	version = ""
	commit  = ""
	date    = ""
)

// Placeholders used when a field was not stamped at link time — a `go build`
// with no -ldflags, which is how every developer builds locally.
const (
	unknownVersion = "dev"
	unknownCommit  = "none"
	unknownDate    = "unknown"

	// shortCommitLen matches git's default abbreviation length.
	shortCommitLen = 7
)

// Info is the build identity of the running binary. It crosses the Wails
// bridge to the frontend, hence the JSON tags.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Date    string `json:"date"`
}

// Get returns the build identity stamped into this binary, with placeholders
// substituted for any field the linker did not set.
func Get() Info {
	return newInfo(version, commit, date)
}

// newInfo normalizes raw link-time values. An unset -X flag leaves a field
// empty, and an empty version rendered into the UI reads as a bug rather than
// as a development build.
func newInfo(rawVersion, rawCommit, rawDate string) Info {
	return Info{
		Version: orDefault(rawVersion, unknownVersion),
		Commit:  orDefault(rawCommit, unknownCommit),
		Date:    orDefault(rawDate, unknownDate),
	}
}

// ShortCommit abbreviates the commit to git's default length. Commits shorter
// than that (including the "none" placeholder) are returned unchanged.
func (i Info) ShortCommit() string {
	if len(i.Commit) <= shortCommitLen {
		return i.Commit
	}
	return i.Commit[:shortCommitLen]
}

// String renders the identity for logs and the about line, e.g.
// "v1.2.0 (a1b2c3d, 2026-08-02)".
func (i Info) String() string {
	return i.Version + " (" + i.ShortCommit() + ", " + i.Date + ")"
}

// orDefault returns fallback when value is empty or only whitespace.
func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
