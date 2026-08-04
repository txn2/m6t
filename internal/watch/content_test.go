package watch

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadFileNormalizesLFContent(t *testing.T) {
	const body = "kind: Deployment\nmetadata:\n  name: web\n"
	root := tree(t, nil, nil)
	write(t, root, "deploy.yaml", body)

	got, err := ReadFile(root, "deploy.yaml")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if got.Content != body {
		t.Errorf("Content = %q, want %q", got.Content, body)
	}
	if got.CRLF || got.MixedEOL || got.ReadOnly {
		t.Errorf("CRLF/MixedEOL/ReadOnly = %v/%v/%v, want all false for a small LF file",
			got.CRLF, got.MixedEOL, got.ReadOnly)
	}
	if got.Size != int64(len(body)) {
		t.Errorf("Size = %d, want %d", got.Size, len(body))
	}
}

func TestReadFileNormalizesUniformCRLFAndReportsIt(t *testing.T) {
	root := tree(t, nil, nil)
	write(t, root, "svc.yaml", "kind: Service\r\nmetadata:\r\n  name: web\r\n")

	got, err := ReadFile(root, "svc.yaml")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if got.Content != "kind: Service\nmetadata:\n  name: web\n" {
		t.Errorf("Content = %q, want LF-normalized", got.Content)
	}
	if !got.CRLF {
		t.Error("CRLF = false, want true for a uniformly CRLF file")
	}
	if got.MixedEOL || got.ReadOnly {
		t.Error("a uniformly CRLF file must be editable, not read-only")
	}
}

// A file with no single EOL style has none to preserve. Saving it back
// through an editor that normalizes line endings would rewrite every line it
// never touched — the exact `git diff` surprise the issue's acceptance
// criterion rules out — so such a file opens read-only instead.
func TestReadFileReportsMixedLineEndingsAsReadOnly(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"crlf and lf blended", "a: 1\r\nb: 2\nc: 3\r\n"},
		{"bare cr", "a: 1\rb: 2\n"},
		{"cr at end of file", "a: 1\nb: 2\r"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := tree(t, nil, nil)
			write(t, root, "f.yaml", tt.body)

			got, err := ReadFile(root, "f.yaml")
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			if !got.MixedEOL {
				t.Error("MixedEOL = false, want true")
			}
			if !got.ReadOnly {
				t.Error("ReadOnly = false, want true so the file is never written back")
			}
			if got.CRLF {
				t.Error("CRLF = true, want false — a mixed file has no uniform style to restore")
			}
			if strings.ContainsRune(got.Content, '\r') {
				t.Errorf("Content = %q, want every line ending collapsed for display", got.Content)
			}
		})
	}
}

// classifyEOL is exercised directly because uniformity is the property the
// round-trip guarantee rests on, and the boundary cases (a file with no line
// endings at all, one whose only newline is a CRLF) are cheaper to state
// here than to build fixtures for.
func TestClassifyEOLRequiresUniformity(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		wantCRLF  bool
		wantMixed bool
	}{
		{"empty", "", false, false},
		{"no line endings", "a: 1", false, false},
		{"all lf", "a\nb\n", false, false},
		{"all crlf", "a\r\nb\r\n", true, false},
		{"single crlf", "a\r\n", true, false},
		{"one stray lf among crlf", "a\r\nb\n", false, true},
		{"one stray crlf among lf", "a\nb\r\n", false, true},
		{"bare cr only", "a\rb", false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			crlf, mixed := classifyEOL([]byte(tt.body))
			if crlf != tt.wantCRLF || mixed != tt.wantMixed {
				t.Errorf("classifyEOL(%q) = (crlf=%v, mixed=%v), want (crlf=%v, mixed=%v)",
					tt.body, crlf, mixed, tt.wantCRLF, tt.wantMixed)
			}
		})
	}
}

// The acceptance criterion in issue #7 is exact: a save followed by `git
// diff` must show only the edit, with no line-ending surprise. This
// exercises the full read -> edit -> write round trip for both uniform EOL
// styles and asserts the bytes on disk, not just what ReadFile reports.
func TestWriteFileRoundTripsUniformLFAndCRLFExactly(t *testing.T) {
	tests := []struct {
		name string
		disk string
		want string
	}{
		{"lf", "a: 1\nb: 2\n", "a: 1\nb: 2\nc: 3\n"},
		{"crlf", "a: 1\r\nb: 2\r\n", "a: 1\r\nb: 2\r\nc: 3\r\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := tree(t, nil, nil)
			write(t, root, "f.yaml", tt.disk)

			read, err := ReadFile(root, "f.yaml")
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			// The edit: append one line, the way an editor would produce it
			// (LF, CodeMirror's own convention).
			if err := WriteFile(root, "f.yaml", read.Content+"c: 3\n", read.CRLF); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}

			if got := readBack(t, root, "f.yaml"); got != tt.want {
				t.Errorf("on-disk content = %q, want %q", got, tt.want)
			}
		})
	}
}

// A no-op save must reproduce the original bytes exactly — no trailing
// newline appended where the file had none, no trailing whitespace trimmed.
// Both would show up as a spurious `git diff` line for a save that changed
// nothing.
func TestWriteFilePreservesMissingTrailingNewlineAndTrailingWhitespace(t *testing.T) {
	tests := []struct {
		name string
		disk string
	}{
		{"no trailing newline", "a: 1\nb: 2"},
		{"trailing whitespace", "a: 1  \nb: 2\t\n"},
		{"empty file", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := tree(t, nil, nil)
			write(t, root, "f.yaml", tt.disk)

			read, err := ReadFile(root, "f.yaml")
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			if err := WriteFile(root, "f.yaml", read.Content, read.CRLF); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}

			if got := readBack(t, root, "f.yaml"); got != tt.disk {
				t.Errorf("on-disk content = %q, want unchanged %q", got, tt.disk)
			}
		})
	}
}

// Replacing a file by rename gives it a fresh inode, so its mode has to be
// carried over deliberately. Dropping an executable script to the default
// 0640 would show in `git diff` as a mode change the user never made.
func TestWriteFilePreservesTheTargetsMode(t *testing.T) {
	root := tree(t, nil, nil)
	write(t, root, "deploy.sh", "#!/bin/sh\necho hi\n")
	path := filepath.Join(root, "deploy.sh")
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatalf("chmod fixture: %v", err)
	}

	if err := WriteFile(root, "deploy.sh", "#!/bin/sh\necho bye\n", false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Errorf("mode = %v, want 0755 preserved across the atomic replace", got)
	}
}

// The atomic write publishes through a scratch file. One left behind would
// show up in the user's `git status` as an untracked file m6t created.
func TestWriteFileLeavesNoScratchFileBehind(t *testing.T) {
	root := tree(t, nil, nil)
	write(t, root, "f.yaml", "a: 1\n")

	if err := WriteFile(root, "f.yaml", "a: 2\n", false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), tempSuffix) {
			t.Errorf("scratch file %s survived the save", e.Name())
		}
	}
}

// A file deleted underneath an open tab must not trap the user's unsaved
// edits with nowhere to put them. Recreating a file they explicitly pressed
// save on is the lesser evil.
func TestWriteFileCreatesAFileDeletedUnderneathIt(t *testing.T) {
	root := tree(t, nil, nil)

	if err := WriteFile(root, "recovered.yaml", "a: 1\n", false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if got := readBack(t, root, "recovered.yaml"); got != "a: 1\n" {
		t.Errorf("on-disk content = %q, want %q", got, "a: 1\n")
	}
}

func TestWriteFileCreatesWithTheDefaultModeNotTheUmaskWidenedOne(t *testing.T) {
	root := tree(t, nil, nil)

	if err := WriteFile(root, "new.yaml", "a: 1\n", false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	info, err := os.Stat(filepath.Join(root, "new.yaml"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != fs.FileMode(filePerm) {
		t.Errorf("mode = %v, want %v — the same default Create uses", got, fs.FileMode(filePerm))
	}
}

func TestReadFileRejectsADirectory(t *testing.T) {
	root := tree(t, nil, []string{"manifests"})

	if _, err := ReadFile(root, "manifests"); !errors.Is(err, ErrIsDirectory) {
		t.Errorf("ReadFile(dir) = %v, want ErrIsDirectory", err)
	}
}

func TestWriteFileRejectsADirectory(t *testing.T) {
	root := tree(t, nil, []string{"manifests"})

	if err := WriteFile(root, "manifests", "x", false); !errors.Is(err, ErrIsDirectory) {
		t.Errorf("WriteFile(dir) = %v, want ErrIsDirectory", err)
	}
}

func TestContentOperationsRejectPathsEscapingRoot(t *testing.T) {
	root := tree(t, nil, nil)

	if _, err := ReadFile(root, "../escape.yaml"); !errors.Is(err, ErrOutsideRoot) {
		t.Errorf("ReadFile(../escape.yaml) = %v, want ErrOutsideRoot", err)
	}
	if err := WriteFile(root, "../escape.yaml", "x", false); !errors.Is(err, ErrOutsideRoot) {
		t.Errorf("WriteFile(../escape.yaml) = %v, want ErrOutsideRoot", err)
	}
}

func TestContentOperationsRejectGitInternals(t *testing.T) {
	root := tree(t, nil, nil)

	if _, err := ReadFile(root, ".git/HEAD"); !errors.Is(err, ErrGitInternal) {
		t.Errorf("ReadFile(.git/HEAD) = %v, want ErrGitInternal", err)
	}
	if err := WriteFile(root, ".git/HEAD", "x", false); !errors.Is(err, ErrGitInternal) {
		t.Errorf("WriteFile(.git/HEAD) = %v, want ErrGitInternal", err)
	}
}

func TestContentOperationsRejectRootItself(t *testing.T) {
	root := tree(t, nil, nil)

	if _, err := ReadFile(root, ""); !errors.Is(err, ErrNoPath) {
		t.Errorf("ReadFile(root) = %v, want ErrNoPath", err)
	}
	if err := WriteFile(root, "", "x", false); !errors.Is(err, ErrNoPath) {
		t.Errorf("WriteFile(root) = %v, want ErrNoPath", err)
	}
}

func TestReadFileReportsReadOnlyOverTheLargeFileThreshold(t *testing.T) {
	root := tree(t, nil, nil)
	write(t, root, "big.yaml", strings.Repeat("a", LargeFileThreshold+1))

	got, err := ReadFile(root, "big.yaml")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !got.ReadOnly {
		t.Error("ReadOnly = false, want true over LargeFileThreshold")
	}
	if got.MixedEOL {
		t.Error("MixedEOL = true, want false — this file is read-only for its size")
	}
}

func TestReadFileRefusesOverTheHardSizeCeiling(t *testing.T) {
	root := tree(t, nil, nil)
	path := filepath.Join(root, "huge.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("creating fixture: %v", err)
	}
	if err := f.Truncate(MaxEditableSize + 1); err != nil {
		t.Fatalf("truncating fixture: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("closing fixture: %v", err)
	}

	if _, err := ReadFile(root, "huge.bin"); !errors.Is(err, ErrTooLarge) {
		t.Errorf("ReadFile(huge) = %v, want ErrTooLarge", err)
	}
}

func TestReadFileRefusesBinaryContent(t *testing.T) {
	root := tree(t, nil, nil)
	write(t, root, "logo.png", "\x89PNG\x00\x00\x00\rIHDR\x00\x00")

	if _, err := ReadFile(root, "logo.png"); !errors.Is(err, ErrBinaryFile) {
		t.Errorf("ReadFile(binary) = %v, want ErrBinaryFile", err)
	}
}

func TestReadFileAcceptsTextWithNoNulBytes(t *testing.T) {
	root := tree(t, nil, nil)
	write(t, root, "readme.md", "# Title\n\nSome *text*, no null bytes here.\n")

	if _, err := ReadFile(root, "readme.md"); err != nil {
		t.Errorf("ReadFile(text) = %v, want no error", err)
	}
}

func TestReadFileReportsAMissingFile(t *testing.T) {
	root := tree(t, nil, nil)

	if _, err := ReadFile(root, "missing.yaml"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("ReadFile(missing) = %v, want it to wrap fs.ErrNotExist", err)
	}
}

func TestContentOperationsFailOverANonexistentRoot(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")

	if _, err := ReadFile(missing, "f.yaml"); err == nil {
		t.Error("ReadFile over a missing root succeeded, want an error")
	}
	if err := WriteFile(missing, "f.yaml", "x", false); err == nil {
		t.Error("WriteFile over a missing root succeeded, want an error")
	}
}

// looksBinary only samples a file's head, the way git's own heuristic does.
// A NUL past that window must not condemn an otherwise-text file.
func TestLooksBinaryOnlySniffsTheHead(t *testing.T) {
	data := bytes.Repeat([]byte("a"), binarySniffLen+10)
	data[len(data)-1] = 0

	if looksBinary(data) {
		t.Error("looksBinary = true for a NUL past the sniff window, want false")
	}

	data[10] = 0
	if !looksBinary(data) {
		t.Error("looksBinary = false for a NUL inside the sniff window, want true")
	}
}

// write seeds a fixture with exact content: tree itself always writes "x" as
// a placeholder, which these cases need to control.
func write(t *testing.T, root, relPath, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("making parent of %s: %v", relPath, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatalf("writing %s: %v", relPath, err)
	}
}

// readBack reads a fixture off disk, bypassing this package entirely — an
// assertion about what WriteFile produced must not be routed through
// ReadFile, which normalizes.
func readBack(t *testing.T, root, relPath string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relPath)))
	if err != nil {
		t.Fatalf("reading %s back: %v", relPath, err)
	}
	return string(raw)
}

// The stat succeeds and the read does not: a file whose mode denies reading
// is the ordinary way that happens, and ReadFile has to report it rather than
// return empty content as though the file were blank.
func TestReadFileReportsAnUnreadableFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, which can read a 0000 file")
	}
	root := tree(t, nil, nil)
	write(t, root, "secret.yaml", "a: 1\n")
	if err := os.Chmod(filepath.Join(root, "secret.yaml"), 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}

	if _, err := ReadFile(root, "secret.yaml"); err == nil {
		t.Error("ReadFile on an unreadable file succeeded, want an error")
	}
}

// A path whose parent is a regular file is neither "not there" nor a
// directory — targetPerm has to surface that rather than treat it as a file
// waiting to be created.
func TestWriteFileReportsAPathUnderneathARegularFile(t *testing.T) {
	root := tree(t, nil, nil)
	write(t, root, "a.yaml", "a: 1\n")

	err := WriteFile(root, "a.yaml/child.yaml", "x", false)
	if err == nil {
		t.Fatal("WriteFile under a regular file succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "a.yaml/child.yaml") {
		t.Errorf("error = %q, want it to name the path", err)
	}
}

// The scratch file lands beside the target, so a target in a directory that
// does not exist fails at the scratch rather than half-writing anything.
func TestWriteFileReportsAMissingParentDirectory(t *testing.T) {
	root := tree(t, nil, nil)

	err := WriteFile(root, "no-such-dir/f.yaml", "a: 1\n", false)
	if err == nil {
		t.Fatal("WriteFile into a missing directory succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "no-such-dir/f.yaml") {
		t.Errorf("error = %q, want it to name the path", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, "no-such-dir")); !os.IsNotExist(statErr) {
		t.Error("WriteFile created the directory it should have refused")
	}
}

func TestSyncCloseReportsAWriteFailure(t *testing.T) {
	f, err := os.Create(filepath.Join(t.TempDir(), "x"))
	if err != nil {
		t.Fatalf("creating fixture: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("closing fixture: %v", err)
	}

	// Writing to an already-closed file is the cheapest way to exercise the
	// failure path a full disk would otherwise be needed for.
	if err := syncClose(f, []byte("data")); err == nil {
		t.Error("syncClose on a closed file succeeded, want an error")
	}
}

func TestSyncCloseWritesAndClosesOnTheHappyPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("creating fixture: %v", err)
	}

	if err := syncClose(f, []byte("data")); err != nil {
		t.Fatalf("syncClose: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if string(raw) != "data" {
		t.Errorf("content = %q, want %q", raw, "data")
	}
	// A second close must fail, proving the first one happened.
	if err := f.Close(); err == nil {
		t.Error("syncClose left the file open")
	}
}
