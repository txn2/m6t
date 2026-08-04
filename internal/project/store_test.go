package project

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tempConfigDir returns a fresh, empty configuration directory.
func tempConfigDir(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

// registryFile is the projects.yaml inside a configuration directory, for the
// tests that seed or inspect it directly.
func registryFile(dir string) string {
	return filepath.Join(dir, configFile)
}

func TestLoadMissingFileIsAnEmptyRegistry(t *testing.T) {
	projects, err := load(tempConfigDir(t))
	if err != nil {
		t.Fatalf("load of a missing file: %v", err)
	}
	if len(projects) != 0 {
		t.Errorf("load returned %d projects, want 0 — first launch is not an error", len(projects))
	}
}

// A config the user has broken by hand must surface. Returning an empty
// registry would present them with an app that has apparently forgotten every
// project, and the next save would make that true.
func TestLoadMalformedConfigIsAnError(t *testing.T) {
	dir := tempConfigDir(t)
	if err := os.WriteFile(registryFile(dir), []byte("projects: [oh: dear: no\n"), configPerm); err != nil {
		t.Fatalf("seeding a malformed config: %v", err)
	}

	projects, err := load(dir)
	if err == nil {
		t.Fatalf("load of a malformed config returned %v, want an error", projects)
	}
	if !strings.Contains(err.Error(), registryFile(dir)) {
		t.Errorf("error %q does not name the file the user has to go fix", err)
	}
}

func TestSaveLoadRoundTripPreservesEveryField(t *testing.T) {
	dir := tempConfigDir(t)
	want := []Project{{
		Name: "infra-prod",
		Path: "~/workspace/ops/infra-prod",
		Kube: Kube{Context: "prod-us-west", Namespace: "default", Protected: true},
		Helm: Helm{DefaultValues: []string{"values.yaml", "values-prod.yaml"}},
	}}

	if err := save(dir, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := load(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	if len(got) != 1 {
		t.Fatalf("loaded %d projects, want 1", len(got))
	}
	if got[0].Name != want[0].Name || got[0].Path != want[0].Path {
		t.Errorf("identity round-tripped as %+v, want %+v", got[0], want[0])
	}
	if got[0].Kube != want[0].Kube {
		t.Errorf("kube binding round-tripped as %+v, want %+v", got[0].Kube, want[0].Kube)
	}
	if strings.Join(got[0].Helm.DefaultValues, ",") != strings.Join(want[0].Helm.DefaultValues, ",") {
		t.Errorf("helm defaults round-tripped as %v, want %v", got[0].Helm.DefaultValues, want[0].Helm.DefaultValues)
	}
}

// The written file has to be the shape DESIGN.md §4 documents, not merely
// something this package can read back. A round-trip test alone would pass on
// any self-consistent encoding.
func TestSaveWritesTheDocumentedSchema(t *testing.T) {
	dir := tempConfigDir(t)
	if err := save(dir, []Project{{Name: "infra", Path: "~/infra", Kube: Kube{Context: "prod"}}}); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(registryFile(dir))
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	for _, want := range []string{"projects:", "name: infra", "path: ~/infra", "context: prod"} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("projects.yaml is missing %q; got:\n%s", want, raw)
		}
	}
}

// An unset binding must not litter the file with empty scaffolding — the
// omitempty tags are what keep a hand-edited config readable.
func TestSaveOmitsEmptyBindings(t *testing.T) {
	dir := tempConfigDir(t)
	if err := save(dir, []Project{{Name: "plain", Path: "/tmp/plain"}}); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(registryFile(dir))
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	for _, unwanted := range []string{"kube:", "helm:", "protected:"} {
		if strings.Contains(string(raw), unwanted) {
			t.Errorf("projects.yaml contains %q for a project with no binding; got:\n%s", unwanted, raw)
		}
	}
}

// The temp file the atomic write uses must not survive the write. A save that
// leaves one behind turns every write into an accumulating pile of debris in
// the user's config directory.
func TestSaveLeavesNoTemporaryFileBehind(t *testing.T) {
	dir := t.TempDir()

	for range 3 {
		if err := save(dir, []Project{{Name: "a", Path: "/tmp/a"}}); err != nil {
			t.Fatalf("save: %v", err)
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading the config directory: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != configFile {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("config directory holds %v, want just %s", names, configFile)
	}
}

func TestSaveIsOwnerOnly(t *testing.T) {
	dir := tempConfigDir(t)
	if err := save(dir, []Project{{Name: "a", Path: "/tmp/a"}}); err != nil {
		t.Fatalf("save: %v", err)
	}

	info, err := os.Stat(registryFile(dir))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != configPerm {
		t.Errorf("projects.yaml mode = %o, want %o", perm, configPerm)
	}
}

// A registry built without a config path reports it rather than pretending to
// be empty, on both the read and the write side.
func TestNoConfigPathIsReportedNotIgnored(t *testing.T) {
	if _, err := load(""); !errors.Is(err, errNoConfigDir) {
		t.Errorf("load(\"\") = %v, want errNoConfigDir", err)
	}
	if err := save("", nil); !errors.Is(err, errNoConfigDir) {
		t.Errorf("save(\"\") = %v, want errNoConfigDir", err)
	}
}

func TestSaveReportsAnUnwritableDirectory(t *testing.T) {
	// A directory that does not exist cannot be opened as a root, which is the
	// first thing save does.
	err := save(filepath.Join(t.TempDir(), "absent"), nil)
	if err == nil {
		t.Fatal("save into a missing directory succeeded, want an error")
	}
}

func TestAbbreviateAndExpandAreInverses(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skipf("no home directory on this machine: %v", err)
	}

	tests := []struct {
		name     string
		absolute string
		want     string
	}{
		{
			name:     "path under home abbreviates",
			absolute: filepath.Join(home, "workspace", "infra"),
			want:     "~" + string(filepath.Separator) + filepath.Join("workspace", "infra"),
		},
		{
			name:     "home itself abbreviates",
			absolute: home,
			want:     "~",
		},
		{
			name:     "path outside home is unchanged",
			absolute: filepath.Join(string(filepath.Separator), "opt", "infra"),
			want:     filepath.Join(string(filepath.Separator), "opt", "infra"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := abbreviate(tt.absolute)
			if got != tt.want {
				t.Errorf("abbreviate(%q) = %q, want %q", tt.absolute, got, tt.want)
			}
			if back := expand(got); back != tt.absolute {
				t.Errorf("expand(abbreviate(%q)) = %q, want the original", tt.absolute, back)
			}
		})
	}
}

// "~user" means another account's home directory. Expanding it would be m6t
// opening a repository on someone else's behalf, so it stays literal.
func TestExpandLeavesOtherUsersHomeAlone(t *testing.T) {
	for _, path := range []string{"~someone/repo", "~someone", "relative/path", ""} {
		if got := expand(path); got != path {
			t.Errorf("expand(%q) = %q, want it unchanged", path, got)
		}
	}
}

func TestConfigDirIsTheAppConfigDirectory(t *testing.T) {
	// The real config root: the test must not create the directory somewhere
	// unexpected, so it asserts the shape rather than the absolute location.
	dir, err := ConfigDir()
	if err != nil {
		t.Fatalf("ConfigDir: %v", err)
	}
	if filepath.Base(dir) != appDir {
		t.Errorf("ConfigDir = %q, want it to end in %s", dir, appDir)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Errorf("ConfigDir did not create its directory: %v", err)
	}
}

// writeAll owns the failure paths that turn a half-written temp file into a
// corrupt registry, and they are only reachable with a file handle that is
// already unusable.
func TestWriteAllReportsAFailedWrite(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "closed")
	if err != nil {
		t.Fatalf("creating the temp file: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("closing it: %v", err)
	}

	if err := writeAll(f, []byte("payload")); err == nil {
		t.Error("writeAll to a closed file succeeded, want an error")
	}
}

// A rename cannot replace a directory, which is the closest reachable stand-in
// for the publish step failing after the content is already durable.
func TestSaveReportsAFailedRename(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(registryFile(dir), 0o750); err != nil {
		t.Fatalf("occupying the destination: %v", err)
	}

	err := save(dir, []Project{{Name: "a", Path: "/tmp/a"}})
	if err == nil {
		t.Fatal("save over a directory succeeded, want an error")
	}

	// The temp file must still be cleaned up on the failing path.
	entries, readErr := os.ReadDir(dir)
	if readErr != nil {
		t.Fatalf("reading the directory: %v", readErr)
	}
	if len(entries) != 1 {
		t.Errorf("a failed save left %d entries behind, want just the occupied destination", len(entries))
	}
}

// projects.yaml is a text file people copy between machines. The forward-slash
// form this package writes must expand on every platform, or a config written
// on a Mac would resolve to a literal "~" directory on Windows.
func TestExpandAlwaysAcceptsTheForwardSlashForm(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skipf("no home directory on this machine: %v", err)
	}

	want := filepath.Join(home, "workspace", "infra")
	if got := expand("~/workspace/infra"); got != want {
		t.Errorf("expand = %q, want %q", got, want)
	}
	if got := expand(homeMarker + string(filepath.Separator) + "workspace"); got != filepath.Join(home, "workspace") {
		t.Errorf("expand of the platform-separator form = %q, want %q", got, filepath.Join(home, "workspace"))
	}
}
