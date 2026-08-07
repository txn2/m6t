package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The write's failure paths.
//
// They are in the same package as the code because the two that matter cannot
// be reached through Save: a write and a sync only fail on a file handle the
// store would never hand itself, and reaching them from outside would mean
// contriving a filesystem rather than a file. What they are worth testing for
// is not that an error is returned — it is that the error says which step
// failed and names the file, because this is the one report the user gets when
// their workspace does not persist.

func TestWriteAllReportsAFailedWrite(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "scratch")
	if err != nil {
		t.Fatalf("creating the scratch file: %v", err)
	}
	// Closed underneath it: the write cannot land, which is what a full disk
	// or a revoked handle looks like from here.
	if err := f.Close(); err != nil {
		t.Fatalf("closing the scratch file: %v", err)
	}

	err = writeAll(f, []byte("version: 1\n"))

	if err == nil {
		t.Fatal("writeAll succeeded on a closed file, want an error")
	}
	if !strings.Contains(err.Error(), "writing") || !strings.Contains(err.Error(), f.Name()) {
		t.Errorf("error = %q, want it to name the step and the file", err)
	}
}

// A pipe accepts the write and refuses the sync, which is the one place a
// durability failure can be produced without a filesystem that lies.
func TestWriteAllReportsAFailedSync(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("creating the pipe: %v", err)
	}
	t.Cleanup(func() { _ = reader.Close() })

	err = writeAll(writer, []byte("version: 1\n"))

	if err == nil {
		t.Fatal("writeAll succeeded without a durable write, want an error")
	}
	if !strings.Contains(err.Error(), "syncing") {
		t.Errorf("error = %q, want it to name the sync", err)
	}
}

// The rename is the step that publishes the session, and the one whose failure
// must not leave the scratch file behind: a save that failed once would
// otherwise leave a file that every later save trips over.
func TestSaveReportsAFailedRenameAndClearsTheScratchFile(t *testing.T) {
	dir := t.TempDir()
	// A non-empty directory where the session file goes. The rename cannot
	// replace it, which is a real state a config directory can be left in by
	// hand or by another tool.
	occupied := filepath.Join(dir, configFile)
	if err := os.MkdirAll(filepath.Join(occupied, "in-the-way"), 0o700); err != nil {
		t.Fatalf("occupying the session path: %v", err)
	}

	err := New(dir).Save(State{Version: Version, ActiveProject: "infra"})

	if err == nil {
		t.Fatal("Save succeeded over an occupied path, want an error")
	}
	if !strings.Contains(err.Error(), "replacing") {
		t.Errorf("error = %q, want it to name the step that failed", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, tempFile)); !os.IsNotExist(statErr) {
		t.Errorf("stat of the scratch file = %v, want it removed after a failed save", statErr)
	}
}

// A configuration directory that is not there is not the same as one this
// build was never given: the first is a path that failed to open and is
// reported, the second is the store the app builds when the OS will not say
// where its config lives.
func TestAMissingDirectoryLoadsDefaultsAndRefusesToSave(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "not-created")
	store := New(missing)

	if got := store.Load(); got.Version != 0 || len(got.Projects) != 0 {
		t.Errorf("Load = %+v, want the zero session", got)
	}

	err := store.Save(State{Version: Version})
	if err == nil {
		t.Fatal("Save succeeded into a directory that does not exist, want an error")
	}
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("error = %q, want it to name the directory", err)
	}
}

// A project with no terminals and no expanded directories is the ordinary
// shape of a project the user has only ever looked at, and both lists have to
// come back absent rather than as empty lists that the encoder would then
// write out as noise.
func TestNormalizeDropsListsWithNothingInThem(t *testing.T) {
	got := normalize(State{
		Version:  Version,
		Projects: []Project{{Name: "infra", Terminals: []Terminal{}, TreeExpanded: []string{}}},
	})

	if got.Projects[0].Terminals != nil {
		t.Errorf("terminals = %+v, want nil", got.Projects[0].Terminals)
	}
	if got.Projects[0].TreeExpanded != nil {
		t.Errorf("expanded = %+v, want nil", got.Projects[0].TreeExpanded)
	}
}

// The terminal cap and the expanded-directory cap are the two that a hand
// edit is most likely to blow past, and unlike the editor cap they are not
// exercised anywhere else.
func TestNormalizeCapsTerminalsAndExpandedDirectories(t *testing.T) {
	dir := t.TempDir()
	terminals := make([]Terminal, maxTerminals+5)
	for i := range terminals {
		terminals[i] = Terminal{Title: "shell", Cwd: dir}
	}
	expanded := make([]string, maxExpanded+5)
	for i := range expanded {
		expanded[i] = filepath.Join("d", string(rune('a'+i%26)), string(rune('a'+i/26%26)), string(rune('a'+i/676%26)))
	}

	got := normalize(State{
		Version:  Version,
		Projects: []Project{{Name: "infra", Terminals: terminals, TreeExpanded: expanded}},
	})

	if len(got.Projects[0].Terminals) != maxTerminals {
		t.Errorf("terminals = %d, want %d", len(got.Projects[0].Terminals), maxTerminals)
	}
	if len(got.Projects[0].TreeExpanded) > maxExpanded {
		t.Errorf("expanded = %d, want at most %d", len(got.Projects[0].TreeExpanded), maxExpanded)
	}
}
