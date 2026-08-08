// Package manifest answers one question about a project's checkout: which
// Kubernetes objects does this repository declare?
//
// The answer is a list of references — apiVersion, kind, namespace, name, and
// the file each came from — and nothing else. No object body is retained, no
// schema is consulted, and nothing here contacts a cluster. That restraint is
// what makes this the input to the watch service (DESIGN.md §3.2) rather than a
// validator: `internal/kubewatch` needs to know what to look for, and every
// field beyond identity would be a field it had to decide whether to trust.
//
// Reading a repository of YAML written by other people means most of what is
// found is not a manifest, so the rule is that a scan always produces an index.
// A file that will not parse, a document with half a manifest's identity, a
// chart whose templates are Go source rather than YAML: each becomes a Notice
// naming the file and the reason, and the scan continues. Nothing a repository
// can contain makes this fail — the only errors returned are about the root
// itself being unreadable, which is a broken project rather than a broken file.
//
// The counterpart rule is that silence has to mean something. A `values.yaml`,
// a CI workflow and a `.editorconfig`-adjacent scrap of YAML are all documents
// with no apiVersion and no kind, and noticing each one would bury the file
// that was meant to be a Deployment and is missing its name. So a document
// claiming none of a manifest's identity is skipped without comment, and a
// document claiming part of it is reported. See classify.
//
// It imports nothing first-party (CLAUDE.md, DESIGN.md §3.2); internal/app is
// what hands its output to the watch service.
package manifest

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// maxFileSize bounds one file this package will read into memory.
//
// A manifest repository has no legitimate 8 MiB YAML file; what a file that
// size actually is, when it is in a directory of manifests, is a rendered
// bundle, a dump, or a fixture someone committed. Reading it would cost the
// scan more than every real manifest in the repository combined, and the scan
// runs again on every file change. The limit is a notice rather than a refusal,
// so the user is told which file was too large instead of wondering why its
// objects never appeared.
const maxFileSize = 8 << 20

// chartFile marks a Helm chart directory. Its subtree is skipped — see skipDir.
const chartFile = "Chart.yaml"

// Object is one Kubernetes object a repository declares.
//
// APIVersion is carried as written rather than split into group and version.
// Splitting it is `schema.FromAPIVersionAndKind`'s job and belongs where the
// GroupVersionKind is actually needed; doing it here would put an apimachinery
// dependency in the parser to save the one caller a function call.
//
// Namespace is what the document states, which is routinely nothing. An empty
// namespace is not "default" — it means the manifest deferred the decision, and
// resolving it needs to know whether the kind is namespaced at all, which needs
// discovery against the cluster. That is the watch service's to do, and an
// answer invented here would be wrong for every cluster-scoped object.
type Object struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`

	// File is the repository-relative, slash-separated path the object was
	// read from, so the panel can say where a declaration lives.
	File string `json:"file"`
}

// Notice is one thing the scan could not index, and why.
//
// It names a file rather than a document index. "The third document in
// deploy.yaml" is a position the user has to count out; the file plus the
// reason is what they need to go and look.
type Notice struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
}

// Index is what one scan of a worktree found.
type Index struct {
	// Objects are the declarations, sorted by kind, then namespace, then name,
	// then file. Sorted because the walk order is the filesystem's: an
	// unsorted list would reorder itself between two scans of an unchanged
	// repository, and a panel whose rows move is a panel nobody can read.
	Objects []Object `json:"objects"`

	// Notices are what was skipped, sorted by file then reason.
	Notices []Notice `json:"notices"`
}

// Scan indexes every YAML file under root.
//
// The walk goes through an os.Root, the same confinement internal/watch uses
// for the same reason: a symlink in the repository pointing at /etc must not
// make /etc part of the index. Errors reading an individual file become
// notices; the error return is for a root that cannot be opened or walked at
// all.
func Scan(root string) (Index, error) {
	r, err := os.OpenRoot(root)
	if err != nil {
		return Index{}, fmt.Errorf("indexing %s: %w", root, err)
	}
	defer func() { _ = r.Close() }()

	var index Index
	walkErr := fs.WalkDir(r.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		switch {
		case err != nil:
			// An unreadable subtree is a notice, not a dead scan: a
			// permission-denied directory in a large checkout should cost its
			// own objects and no others.
			index.note(name, reason(err))
			return fs.SkipDir
		case entry.IsDir():
			return skipDir(&index, r.FS(), name, entry)
		case isYAML(entry.Name()):
			read(&index, r.FS(), name)
		}
		return nil
	})
	if walkErr != nil {
		return Index{}, fmt.Errorf("indexing %s: %w", root, walkErr)
	}

	sortIndex(&index)
	return index, nil
}

// note records something the scan could not index. Every notice in this package
// goes through here so that adding one is a line rather than a struct literal
// with two fields to get in the right order.
func (i *Index) note(file, why string) {
	i.Notices = append(i.Notices, Notice{File: file, Reason: why})
}

// skipDir decides whether a directory's contents are indexed.
//
// Three kinds are refused. Dot-directories are tool configuration — `.git`,
// `.github`, `.circleci` — and the YAML in them is a workflow or a hook, never
// a manifest; walking them would trade real notices for a page of noise about
// files nobody meant to deploy. `node_modules` is the same argument at a
// different scale. A Helm chart is refused for the opposite reason: its
// templates are Go templates rather than YAML and would not parse, and the
// objects it declares are the ones `helm template` renders (#14) rather than
// the ones on disk — so the chart gets one notice saying so, instead of one per
// template saying the same thing in worse words.
func skipDir(index *Index, fsys fs.FS, name string, entry fs.DirEntry) error {
	if name == "." {
		return nil
	}
	if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" {
		return fs.SkipDir
	}
	if _, err := fs.Stat(fsys, path.Join(name, chartFile)); err == nil {
		index.note(name, "Helm chart: its objects come from rendering the chart, not from the files on disk")
		return fs.SkipDir
	}
	return nil
}

// isYAML reports whether a filename is one this package parses.
//
// JSON manifests are not indexed even though kubectl accepts them, because
// nobody hand-writes one: a `.json` in a manifest repository is a kubeconfig, a
// values dump or a schema, and indexing it would be a guess made on every
// repository to serve a file layout none of them use.
func isYAML(name string) bool {
	return strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".yml")
}

// read parses one file's documents into the index.
//
// The size is taken from the open file rather than from a Stat before it, so
// the bytes measured are the bytes about to be read. A separate Stat would be a
// second answer about a file that a writer is free to change between the two —
// and this scan runs off file-change events, which is precisely when something
// is writing.
func read(index *Index, fsys fs.FS, name string) {
	file, err := fsys.Open(name)
	if err != nil {
		index.note(name, reason(err))
		return
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil {
		index.note(name, reason(err))
		return
	}
	if info.Size() > maxFileSize {
		index.note(name, fmt.Sprintf("too large to index (%d bytes, limit %d)", info.Size(), maxFileSize))
		return
	}

	decode(index, name, file)
}

// document is the identity fields a manifest is recognized by. Everything else
// in the document is discarded by the decoder, which is the point: this package
// reads names, not objects.
type document struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Name      string `yaml:"name"`
		Namespace string `yaml:"namespace"`
	} `yaml:"metadata"`
}

// decode walks the YAML stream in one file.
//
// A parse failure ends the file rather than skipping to the next document,
// because it cannot skip: the decoder has lost its place in the stream, and
// what it would resume on is whatever the broken document's indentation made
// the next token. One notice per file is also what the caller can act on — a
// syntax error early in a file would otherwise report itself once per document
// that followed it.
func decode(index *Index, name string, r io.Reader) {
	decoder := yaml.NewDecoder(r)
	for {
		var doc document
		err := decoder.Decode(&doc)
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			index.note(name, reason(err))
			return
		}
		classify(index, name, doc)
	}
}

// classify decides what one document is: an object, a notice, or nothing.
//
// The middle case is the one that earns its keep. A document with an apiVersion
// and a kind and no name is a manifest someone is in the middle of writing, or
// one whose name is templated by a tool this project does not know about — both
// worth saying out loud. A document with none of the three is a values file or
// a CI config, and saying anything about it would be noise the user has to
// learn to ignore, which is how a notice list stops being read at all.
func classify(index *Index, name string, doc document) {
	kind := strings.TrimSpace(doc.Kind)
	version := strings.TrimSpace(doc.APIVersion)
	object := strings.TrimSpace(doc.Metadata.Name)

	if kind == "" && version == "" {
		return
	}
	if missing := absent(version, kind, object); missing != "" {
		index.note(name, "not indexed: a document is missing "+missing)
		return
	}

	index.Objects = append(index.Objects, Object{
		APIVersion: version,
		Kind:       kind,
		Namespace:  strings.TrimSpace(doc.Metadata.Namespace),
		Name:       object,
		File:       name,
	})
}

// absent names the identity fields a document lacks, or "" when it has them
// all.
func absent(version, kind, name string) string {
	var missing []string
	if version == "" {
		missing = append(missing, "apiVersion")
	}
	if kind == "" {
		missing = append(missing, "kind")
	}
	if name == "" {
		missing = append(missing, "metadata.name")
	}
	return strings.Join(missing, " and ")
}

// reason renders a failure as the sentence a notice carries.
//
// The path is stripped because the Notice already names the file, and an
// fs.PathError would otherwise put it in the row twice — once in the column and
// once in the middle of the sentence beside it.
func reason(err error) string {
	if pathErr, ok := errors.AsType[*fs.PathError](err); ok {
		return pathErr.Op + ": " + pathErr.Err.Error()
	}
	return err.Error()
}

// sortIndex puts both lists in a stable order. See Index.Objects.
func sortIndex(index *Index) {
	slices.SortFunc(index.Objects, func(a, b Object) int {
		return compare(
			strings.Compare(a.Kind, b.Kind),
			strings.Compare(a.Namespace, b.Namespace),
			strings.Compare(a.Name, b.Name),
			strings.Compare(a.File, b.File),
		)
	})
	slices.SortFunc(index.Notices, func(a, b Notice) int {
		return compare(strings.Compare(a.File, b.File), strings.Compare(a.Reason, b.Reason))
	})
}

// compare returns the first non-zero comparison, which is what a multi-key sort
// is. It is a function rather than a chain of ifs at each call site because
// there are two call sites and the chain is where a key gets forgotten.
func compare(keys ...int) int {
	for _, key := range keys {
		if key != 0 {
			return key
		}
	}
	return 0
}
