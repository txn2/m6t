package watch

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	// LargeFileThreshold is the size above which ReadFile reports a file as
	// ReadOnly rather than refusing it (DESIGN.md §5): the file still opens
	// and can be read, but "light editing" stops at a repository's occasional
	// large generated file rather than making the app responsible for editing
	// one comfortably.
	LargeFileThreshold = 2 * 1024 * 1024 // 2MiB

	// MaxEditableSize is the hard ceiling ReadFile refuses outright. A file
	// this large marshaled whole across the Wails bridge would stall the
	// webview long before it would be useful to read, let alone edit.
	MaxEditableSize = 25 * 1024 * 1024 // 25MiB

	// binarySniffLen is how much of a file's head ReadFile checks for a NUL
	// byte before deciding it is not text — the same heuristic git uses to
	// classify a file for diffing.
	binarySniffLen = 8000

	// tempSuffix names the scratch file WriteFile publishes from. It is
	// derived per target rather than fixed (the way internal/project's single
	// config file can afford) because two editor tabs can save different
	// files at once, and it is dotted so a scratch left behind by a crash is
	// hidden from the tree by the same rule that hides every other dotfile.
	tempSuffix = ".m6t-save"
)

// Line endings, named because the whole EOL contract below is written in
// terms of them and a stray transposition between the two would be invisible
// at a glance.
const (
	eolLF   = "\n"
	eolCRLF = "\r\n"
	eolCR   = "\r"
)

// readErrFmt is the wrap every ReadFile failure carries, so a caller sees
// which path failed rather than a bare stat or decode error.
const readErrFmt = "reading %s: %w"

// Sentinel errors for content operations, alongside watch.go's own — see that
// file's comment for why these are values rather than formatted strings.
var (
	// ErrIsDirectory reports a ReadFile or WriteFile call naming a directory.
	ErrIsDirectory = errors.New("path is a directory")

	// ErrTooLarge reports a file over MaxEditableSize.
	ErrTooLarge = errors.New("file exceeds the size limit for editing")

	// ErrBinaryFile reports a file whose content does not look like text.
	ErrBinaryFile = errors.New("file does not appear to be text")
)

// FileContent is what ReadFile returns: a file's bytes normalized to LF line
// endings for editing — CodeMirror 6's own internal convention regardless of
// the source — plus what WriteFile needs to put an edit back on disk exactly
// as the original was.
type FileContent struct {
	Content string `json:"content"`

	// CRLF reports a file whose line endings are uniformly CRLF, which
	// WriteFile takes back to restore them. It is only ever true for a
	// uniform file: see MixedEOL.
	CRLF bool `json:"crlf"`

	// MixedEOL reports a file whose line endings are not uniform — a blend
	// of CRLF and LF, or a bare CR. Such a file has no "existing EOL style"
	// to preserve, and writing it back through an editor that normalizes
	// line endings would rewrite every line it did not touch. Rather than
	// guess a dominant style and silently rewrite a manifest, ReadFile
	// reports the file and marks it ReadOnly.
	MixedEOL bool `json:"mixedEol"`

	// ReadOnly reports a file the editor must not write back: one over
	// LargeFileThreshold, or one whose line endings are mixed. It is a
	// statement about what this package can round-trip faithfully, and the
	// UI is what enforces it — WriteFile itself remains a faithful
	// primitive that writes what it is given.
	ReadOnly bool `json:"readOnly"`

	Size int64 `json:"size"`
}

// ReadFile returns relPath's content under root, confined and validated the
// same way List is (os.Root, .git refused). A file over LargeFileThreshold
// or with mixed line endings still comes back — ReadOnly reports it rather
// than refusing it — but a file over MaxEditableSize or one that looks
// binary is refused outright.
func ReadFile(root, relPath string) (FileContent, error) {
	r, err := openRoot(root)
	if err != nil {
		return FileContent{}, err
	}
	defer func() { _ = r.Close() }()

	native, err := entryPath(relPath)
	if err != nil {
		return FileContent{}, err
	}

	info, err := r.Stat(native)
	if err != nil {
		return FileContent{}, fmt.Errorf(readErrFmt, relPath, err)
	}
	if info.IsDir() {
		return FileContent{}, fmt.Errorf(readErrFmt, relPath, ErrIsDirectory)
	}
	if info.Size() > MaxEditableSize {
		return FileContent{}, fmt.Errorf(readErrFmt, relPath, ErrTooLarge)
	}

	raw, err := r.ReadFile(native)
	if err != nil {
		return FileContent{}, fmt.Errorf(readErrFmt, relPath, err)
	}
	if looksBinary(raw) {
		return FileContent{}, fmt.Errorf(readErrFmt, relPath, ErrBinaryFile)
	}

	crlf, mixed := classifyEOL(raw)
	return FileContent{
		Content:  normalizeEOL(raw, crlf, mixed),
		CRLF:     crlf,
		MixedEOL: mixed,
		ReadOnly: mixed || info.Size() > LargeFileThreshold,
		Size:     info.Size(),
	}, nil
}

// WriteFile saves content to relPath under root, converting its LF line
// endings back to CRLF first when crlf is true — the flag ReadFile reported
// for this same file.
//
// The write is atomic (scratch file, then rename over the target), the same
// approach internal/project takes for the registry and for the same reason:
// a crash mid-save leaves either the old file or the new one, never a
// truncated manifest. The target's permissions are carried onto the
// replacement, so saving an executable script does not quietly drop its
// mode — which `git diff` would show as a change the user did not make.
//
// A missing target is created rather than refused. The alternative traps a
// tab's unsaved edits with nowhere to put them when the file is deleted
// underneath it, and losing the user's work is worse than recreating a file
// they explicitly pressed save on.
func WriteFile(root, relPath, content string, crlf bool) error {
	r, err := openRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = r.Close() }()

	native, err := entryPath(relPath)
	if err != nil {
		return err
	}

	perm, err := targetPerm(r, native, relPath)
	if err != nil {
		return err
	}

	data := content
	if crlf {
		data = strings.ReplaceAll(data, eolLF, eolCRLF)
	}
	if err := writeAtomic(r, native, []byte(data), perm); err != nil {
		return fmt.Errorf("writing %s: %w", relPath, err)
	}
	return nil
}

// entryPath validates relPath and returns its native, platform-separator
// form — the same validation List, Create, Rename and Delete run through.
func entryPath(relPath string) (string, error) {
	name, err := entryRelative(relPath)
	if err != nil {
		return "", err
	}
	return filepath.FromSlash(name), nil
}

// targetPerm reports the permissions a write to native should land with:
// the file's own, when it already exists, so a rename-based replacement does
// not change its mode; filePerm for one being created, the same default
// Create uses.
func targetPerm(r *os.Root, native, relPath string) (fs.FileMode, error) {
	info, err := r.Stat(native)
	if errors.Is(err, fs.ErrNotExist) {
		return filePerm, nil
	}
	if err != nil {
		return 0, fmt.Errorf("resolving %s: %w", relPath, err)
	}
	if info.IsDir() {
		return 0, fmt.Errorf("resolving %s: %w", relPath, ErrIsDirectory)
	}
	return info.Mode().Perm(), nil
}

// writeAtomic publishes data to native through a scratch file in the same
// directory, so the rename that completes it is atomic — a scratch on
// another filesystem would not be.
//
// Both failure paths remove the scratch: a failed save that left one behind
// would turn one bad write into a growing pile of them in the user's
// worktree.
func writeAtomic(r *os.Root, native string, data []byte, perm fs.FileMode) error {
	scratch := filepath.Join(filepath.Dir(native), "."+filepath.Base(native)+tempSuffix)

	f, err := r.OpenFile(scratch, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("creating %s: %w", scratch, err)
	}
	if err := syncClose(f, data); err != nil {
		_ = r.Remove(scratch)
		return err
	}

	// Explicit rather than relying on OpenFile's perm, which the process
	// umask can narrow: a 0755 script must come back 0755 even under a
	// restrictive umask.
	if err := r.Chmod(scratch, perm); err != nil {
		_ = r.Remove(scratch)
		return fmt.Errorf("setting mode on %s: %w", scratch, err)
	}
	if err := r.Rename(scratch, native); err != nil {
		_ = r.Remove(scratch)
		return fmt.Errorf("replacing %s: %w", native, err)
	}
	return nil
}

// syncClose writes data to f and closes it, syncing before the close so the
// rename that follows publishes durable content rather than an empty file
// with the right name.
func syncClose(f *os.File, data []byte) error {
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return fmt.Errorf("writing %s: %w", f.Name(), err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("syncing %s: %w", f.Name(), err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", f.Name(), err)
	}
	return nil
}

// classifyEOL reports a file's line-ending style: uniformly CRLF, uniformly
// LF, or mixed.
//
// Uniformity is the whole point. Treating a file as CRLF because it contains
// one CRLF would rewrite every LF in it on the next save, which is precisely
// the line-ending surprise this package exists to avoid — so CRLF is
// reported only when every LF is part of a CRLF and no bare CR is left over.
func classifyEOL(raw []byte) (crlf, mixed bool) {
	carriages := bytes.Count(raw, []byte(eolCR))
	if carriages == 0 {
		return false, false // uniformly LF, or no line endings at all
	}

	pairs := bytes.Count(raw, []byte(eolCRLF))
	everyCarriageIsPaired := carriages == pairs
	everyFeedIsPaired := bytes.Count(raw, []byte(eolLF)) == pairs
	if everyCarriageIsPaired && everyFeedIsPaired {
		return true, false
	}
	return false, true
}

// normalizeEOL renders raw as the LF-only text an editor edits. A mixed file
// has every line-ending form collapsed, which is lossy and safe only because
// ReadFile marks such a file ReadOnly — it is shown, never written back.
func normalizeEOL(raw []byte, crlf, mixed bool) string {
	content := string(raw)
	if mixed {
		return strings.ReplaceAll(strings.ReplaceAll(content, eolCRLF, eolLF), eolCR, eolLF)
	}
	if crlf {
		return strings.ReplaceAll(content, eolCRLF, eolLF)
	}
	return content
}

// looksBinary reports whether the head of data contains a NUL byte — the
// same heuristic git uses to decide a file is not text.
func looksBinary(data []byte) bool {
	return bytes.IndexByte(data[:min(len(data), binarySniffLen)], 0) >= 0
}
