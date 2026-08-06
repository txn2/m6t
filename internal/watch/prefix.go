package watch

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
)

const (
	// prefixLen is how much of each file ReadPrefixes returns.
	//
	// Enough for a caller to classify a file by what its head says without
	// reading it whole: a Kubernetes manifest's apiVersion and kind are
	// conventionally its first two lines, and 2 KiB leaves room for a license
	// header, a block of comments or a leading document separator before
	// them. It is a ceiling, not a promise — a shorter file returns whatever
	// it has.
	prefixLen = 2048

	// maxPrefixBatch bounds one call. The tree asks about the YAML files in a
	// single expanded directory, which is tens of paths; a caller asking
	// about thousands has stopped doing that and is asking this binding to
	// walk a repository, which is the cost the lazy classification exists to
	// avoid.
	maxPrefixBatch = 1024
)

// errBatchTooLarge reports a ReadPrefixes call naming more paths than one
// call is willing to serve. Unexported: no caller distinguishes it from any
// other refusal, and the binding surfaces its text.
var errBatchTooLarge = errors.New("too many paths in one batch")

// ReadPrefixes returns the first prefixLen bytes of each named file, keyed by
// the relPath it was asked for.
//
// It exists so a caller can decide what a file *is* from its content without
// the cost of reading it: the file tree shows a Kubernetes manifest as one
// only when the file says `apiVersion:` and `kind:`, and there is no cheap
// way to know that from a name (issue #38). Deciding here instead would put
// a second copy of that rule in Go beside the frontend's, so this returns
// evidence and the caller judges it.
//
// A path that cannot contribute an answer is absent from the result rather
// than failing the batch: a directory, a file deleted between the listing
// and this call, one the user cannot read, or a binary. The caller is
// classifying, and "no evidence" and "evidence of nothing" lead to the same
// place — the file keeps whatever its name already said. Only a root that
// cannot be opened at all, or an oversized batch, is an error.
func ReadPrefixes(root string, relPaths []string) (map[string]string, error) {
	if len(relPaths) > maxPrefixBatch {
		return nil, fmt.Errorf("reading %d prefixes: %w (max %d)", len(relPaths), errBatchTooLarge, maxPrefixBatch)
	}

	r, err := openRoot(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.Close() }()

	prefixes := make(map[string]string, len(relPaths))
	for _, relPath := range relPaths {
		head, ok := prefixOf(r, relPath)
		if ok {
			prefixes[relPath] = head
		}
	}
	return prefixes, nil
}

// prefixOf reads one file's head, reporting whether it produced usable text.
func prefixOf(r *os.Root, relPath string) (string, bool) {
	name, err := rootRelative(relPath)
	if err != nil {
		return "", false
	}

	// Lstat before Open, and only regular files past it. Opening a named
	// pipe blocks until something writes to it, and a repository is allowed
	// to contain one — this call would then hang holding the batch, and the
	// tree's icons with it. The same check rejects directories, devices,
	// sockets, and symlinks, which os.Root will follow within the root even
	// though it refuses to follow one out of it.
	info, err := r.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}

	file, err := r.Open(name)
	if err != nil {
		return "", false
	}
	defer func() { _ = file.Close() }()

	head, err := io.ReadAll(io.LimitReader(file, prefixLen))
	// A short read is still an answer — io.ReadAll on a truncated stream
	// returns what it got alongside the error, and a partial head classifies
	// as well as a whole one.
	if err != nil && len(head) == 0 {
		return "", false
	}
	if bytes.IndexByte(head, 0) >= 0 {
		// The same NUL heuristic ReadFile uses: a binary file has no head
		// worth handing to a text rule.
		return "", false
	}
	return string(head), true
}
