package manifest

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// write creates a file under root, making its parents.
func write(t *testing.T, root, rel, body string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		t.Fatalf("MkdirAll %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
		t.Fatalf("WriteFile %s: %v", rel, err)
	}
}

// indexOf indexes a temporary root, failing the test if the scan itself errors.
func indexOf(t *testing.T, root string) Index {
	t.Helper()
	index, err := Scan(root)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	return index
}

// names renders an index's objects as "kind/namespace/name@file" lines, which
// is enough identity to assert on without a struct literal per row.
func names(index Index) []string {
	out := make([]string, 0, len(index.Objects))
	for _, o := range index.Objects {
		out = append(out, o.Kind+"/"+o.Namespace+"/"+o.Name+"@"+o.File)
	}
	return out
}

// noticed reports whether some notice for file mentions want.
func noticed(index Index, file, want string) bool {
	for _, n := range index.Notices {
		if n.File == file && strings.Contains(n.Reason, want) {
			return true
		}
	}
	return false
}

func equal(got, want []string) bool {
	return slices.Equal(got, want)
}

func TestScanIndexesEveryDocumentInAMultiDocFile(t *testing.T) {
	root := t.TempDir()
	write(t, root, "deploy.yaml", `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: web
`)

	index := indexOf(t, root)

	want := []string{
		"Deployment/shop/web@deploy.yaml",
		"Service/shop/web@deploy.yaml",
		"ServiceAccount//web@deploy.yaml",
	}
	if got := names(index); !equal(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
	if len(index.Notices) != 0 {
		t.Errorf("notices = %v, want none", index.Notices)
	}
}

// An empty document is what a leading `---`, a trailing `---` and a commented
// out block all decode to. None of them is a problem to report.
func TestScanIgnoresEmptyDocuments(t *testing.T) {
	root := t.TempDir()
	write(t, root, "app.yml", "---\n# nothing here\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: token\n---\n")

	index := indexOf(t, root)

	if got, want := names(index), []string{"Secret//token@app.yml"}; !equal(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
	if len(index.Notices) != 0 {
		t.Errorf("notices = %v, want none", index.Notices)
	}
}

// The acceptance criterion from #12: one good document and one broken one in a
// file indexes the good one and reports the file.
func TestScanReportsAParseFailureWithoutLosingTheFile(t *testing.T) {
	root := t.TempDir()
	write(t, root, "ok.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n")
	write(t, root, "broken.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n\tname: tab-indented\n")

	index := indexOf(t, root)

	if got, want := names(index), []string{"ConfigMap//settings@ok.yaml"}; !equal(got, want) {
		t.Errorf("objects = %v, want the valid file's object only, got %v", got, want)
	}
	if len(index.Notices) != 1 || index.Notices[0].File != "broken.yaml" {
		t.Fatalf("notices = %v, want exactly one for broken.yaml", index.Notices)
	}
	if index.Notices[0].Reason == "" {
		t.Error("the notice carries no reason")
	}
}

// A file whose first document parses and whose second does not keeps the first.
// This is the half a per-file notice could quietly lose.
func TestScanKeepsDocumentsBeforeAParseFailure(t *testing.T) {
	root := t.TempDir()
	write(t, root, "mixed.yaml", "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n---\nkind: [unclosed\n")

	index := indexOf(t, root)

	if got, want := names(index), []string{"Namespace//shop@mixed.yaml"}; !equal(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
	if !noticed(index, "mixed.yaml", "") {
		t.Errorf("notices = %v, want one for mixed.yaml", index.Notices)
	}
}

// A values file, a CI config and a lockfile are all YAML with no manifest
// identity. Noticing them would bury the notices that matter.
func TestScanSaysNothingAboutDocumentsThatAreNotManifests(t *testing.T) {
	root := t.TempDir()
	write(t, root, "values.yaml", "replicaCount: 2\nimage:\n  tag: v1\n")

	index := indexOf(t, root)

	if len(index.Objects) != 0 || len(index.Notices) != 0 {
		t.Errorf("objects = %v, notices = %v, want both empty", index.Objects, index.Notices)
	}
}

// A document that claims part of a manifest's identity is a manifest with
// something wrong with it, and gets said out loud.
func TestScanReportsHalfIdentifiedDocuments(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "no name",
			body: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels:\n    app: web\n",
			want: "metadata.name",
		},
		{
			name: "no apiVersion",
			body: "kind: Deployment\nmetadata:\n  name: web\n",
			want: "apiVersion",
		},
		{
			name: "no kind",
			body: "apiVersion: apps/v1\nmetadata:\n  name: web\n",
			want: "kind",
		},
		{
			name: "a List has no name of its own",
			body: "apiVersion: v1\nkind: List\nitems: []\n",
			want: "metadata.name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			write(t, root, "doc.yaml", tt.body)

			index := indexOf(t, root)

			if len(index.Objects) != 0 {
				t.Errorf("objects = %v, want none", names(index))
			}
			if !noticed(index, "doc.yaml", tt.want) {
				t.Errorf("notices = %v, want one naming %q", index.Notices, tt.want)
			}
		})
	}
}

func TestScanSkipsDotDirectoriesAndNodeModules(t *testing.T) {
	root := t.TempDir()
	write(t, root, ".github/workflows/ci.yaml", "on: push\njobs: {}\n")
	write(t, root, ".git/config.yaml", "apiVersion: v1\nkind: Secret\nmetadata:\n  name: nope\n")
	write(t, root, "node_modules/pkg/k8s.yaml", "apiVersion: v1\nkind: Secret\nmetadata:\n  name: nope\n")
	write(t, root, "keep.yaml", "apiVersion: v1\nkind: Secret\nmetadata:\n  name: yes-please\n")

	index := indexOf(t, root)

	if got, want := names(index), []string{"Secret//yes-please@keep.yaml"}; !equal(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
	if len(index.Notices) != 0 {
		t.Errorf("notices = %v, want none: a skipped directory is not a problem", index.Notices)
	}
}

// A chart's templates are Go templates, not YAML. Parsing them would produce a
// notice per template; the chart gets one instead, and its own manifests are
// #14's to render.
func TestScanReportsAHelmChartOnceAndDoesNotParseItsTemplates(t *testing.T) {
	root := t.TempDir()
	write(t, root, "charts/web/Chart.yaml", "apiVersion: v2\nname: web\nversion: 0.1.0\n")
	write(t, root, "charts/web/values.yaml", "replicas: 1\n")
	write(t, root, "charts/web/templates/deploy.yaml", "kind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n")
	write(t, root, "charts/web/templates/svc.yaml", "kind: Service\nmetadata:\n  name: {{ .Release.Name }}\n")
	write(t, root, "plain.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: real\n")

	index := indexOf(t, root)

	if got, want := names(index), []string{"Service//real@plain.yaml"}; !equal(got, want) {
		t.Errorf("objects = %v, want the non-chart object only, got %v", got, want)
	}
	if len(index.Notices) != 1 {
		t.Fatalf("notices = %v, want exactly one for the chart", index.Notices)
	}
	if !noticed(index, "charts/web", "Helm chart") {
		t.Errorf("notices = %v, want one naming charts/web as a chart", index.Notices)
	}
}

func TestScanReportsAFileTooLargeToIndex(t *testing.T) {
	root := t.TempDir()
	write(t, root, "dump.yaml", "# "+strings.Repeat("x", maxFileSize)+"\n")

	index := indexOf(t, root)

	if len(index.Objects) != 0 {
		t.Errorf("objects = %v, want none", names(index))
	}
	if !noticed(index, "dump.yaml", "too large") {
		t.Errorf("notices = %v, want one saying the file is too large", index.Notices)
	}
}

func TestScanIgnoresFilesThatAreNotYAML(t *testing.T) {
	root := t.TempDir()
	write(t, root, "manifest.json", `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"nope"}}`)
	write(t, root, "README.md", "apiVersion: v1\n")

	index := indexOf(t, root)

	if len(index.Objects) != 0 || len(index.Notices) != 0 {
		t.Errorf("objects = %v, notices = %v, want both empty", names(index), index.Notices)
	}
}

// The walk order is the filesystem's, which differs between platforms and
// between two runs after a rename. A panel whose rows moved would be unreadable.
func TestScanSortsObjectsByKindNamespaceNameFile(t *testing.T) {
	root := t.TempDir()
	write(t, root, "z.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: b\n  namespace: two\n")
	write(t, root, "a.yaml", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: z\n  namespace: one\n")
	write(t, root, "m.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: a\n  namespace: two\n")
	write(t, root, "b.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: b\n  namespace: one\n")

	want := []string{
		"Deployment/one/z@a.yaml",
		"Service/one/b@b.yaml",
		"Service/two/a@m.yaml",
		"Service/two/b@z.yaml",
	}
	if got := names(indexOf(t, root)); !equal(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
}

func TestScanSortsNoticesByFileThenReason(t *testing.T) {
	root := t.TempDir()
	write(t, root, "z.yaml", "kind: Deployment\nmetadata:\n  name: web\n")
	write(t, root, "a.yaml", "apiVersion: v1\nkind: Service\n")

	index := indexOf(t, root)

	if len(index.Notices) != 2 {
		t.Fatalf("notices = %v, want two", index.Notices)
	}
	if index.Notices[0].File != "a.yaml" || index.Notices[1].File != "z.yaml" {
		t.Errorf("notices = %v, want a.yaml before z.yaml", index.Notices)
	}
}

// Whitespace around an identity field is invisible in the panel and would
// produce an object reference the API server has never heard of.
func TestScanTrimsIdentityFields(t *testing.T) {
	root := t.TempDir()
	write(t, root, "pad.yaml", "apiVersion: \"apps/v1 \"\nkind: \" Deployment\"\nmetadata:\n  name: \" web \"\n  namespace: \" shop \"\n")

	if got, want := names(indexOf(t, root)), []string{"Deployment/shop/web@pad.yaml"}; !equal(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
}

// A root that is not there is a broken project, which is the one thing this
// package does report as an error rather than as a notice.
func TestScanFailsOnAnUnopenableRoot(t *testing.T) {
	if _, err := Scan(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Fatal("Scan on a missing root returned no error")
	}
}

// A symlink pointing out of the worktree must not put the target's YAML in the
// index. Two halves: a linked directory is never descended into, because the
// walk sees a symlink rather than a directory; a linked FILE with a .yaml name
// is descended into and is refused by the os.Root the scan opens through, which
// is the half a walk on its own would get wrong.
func TestScanDoesNotFollowSymlinksOutOfTheWorktree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}

	outside := t.TempDir()
	write(t, outside, "secret.yaml", "apiVersion: v1\nkind: Secret\nmetadata:\n  name: elsewhere\n")

	root := t.TempDir()
	write(t, root, "inside.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: here\n")
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.yaml"), filepath.Join(root, "linked.yaml")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	index := indexOf(t, root)

	if got, want := names(index), []string{"Service//here@inside.yaml"}; !equal(got, want) {
		t.Fatalf("objects = %v, want only the object inside the worktree (%v)", got, want)
	}
	if !noticed(index, "linked.yaml", "") {
		t.Errorf("notices = %v, want one saying linked.yaml could not be read", index.Notices)
	}
}

// An unreadable directory costs its own objects and no others.
func TestScanReportsAnUnreadableDirectoryAndKeepsGoing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not deny traversal on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root traverses a 0000 directory regardless of its mode")
	}

	root := t.TempDir()
	write(t, root, "readable.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: here\n")
	write(t, root, "locked/deploy.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: hidden\n")
	locked := filepath.Join(root, "locked")
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	index := indexOf(t, root)

	if got, want := names(index), []string{"Service//here@readable.yaml"}; !equal(got, want) {
		t.Errorf("objects = %v, want %v", got, want)
	}
	if !noticed(index, "locked", "") {
		t.Errorf("notices = %v, want one for the unreadable directory", index.Notices)
	}
}
