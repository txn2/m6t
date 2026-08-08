package kubewatch

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The read-only gate (#12).
//
// This package's entire safety argument is that it cannot change a cluster.
// Every mutation in m6t goes through validate → diff → confirm → apply
// (DESIGN.md §6.1) in internal/kubeexec, and the reason a second package holds
// a client to the same cluster is that it holds a client that cannot write. An
// argument like that is worth exactly as much as its enforcement.
//
// It is a test rather than a semgrep rule for two reasons. It runs on every
// `go test`, so a violation is caught while it is being written rather than at
// the SAST stage; and it reads Go rather than text, so it can be exhaustive
// about the verb list without the false positives a textual rule would produce
// on any future method that happens to be called Delete.
//
// It is deliberately blunt: it forbids the NAMES, not the receivers. A call to
// something called Patch in this package is a finding whether or not it is a
// Kubernetes client, because the cost of renaming an unrelated method is a
// minute and the cost of a false negative here is m6t writing to a cluster
// nobody confirmed.

// mutatingVerbs is every method a client-go typed, dynamic, or discovery client
// offers that changes server state. Apply is included even though it is a
// convenience over Patch, and the Status variants are included because a status
// subresource write is a write.
var mutatingVerbs = []string{
	"Apply",
	"ApplyStatus",
	"Create",
	"Delete",
	"DeleteCollection",
	"Patch",
	"Update",
	"UpdateStatus",
}

func TestPackageCallsNoMutatingVerb(t *testing.T) {
	sources := packageSources(t)
	if len(sources) == 0 {
		t.Fatal("found no sources — this gate must never pass by finding nothing to check")
	}

	fset := token.NewFileSet()
	for _, name := range sources {
		file, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		for _, found := range mutations(fset, file) {
			t.Errorf("%s — internal/kubewatch is read-only by construction, and a cluster mutation belongs in internal/kubeexec behind the confirm gate (DESIGN.md §6.1)",
				found)
		}
	}
	t.Logf("checked %d non-test files for %v", len(sources), mutatingVerbs)
}

// packageSources lists this package's own .go files.
//
// Tests are excluded because a test is allowed to construct a fake cluster's
// contents — a fake's object tracker is not a cluster, and forbidding Create
// there would mean no test could set up the state it is asserting about.
func packageSources(t *testing.T) []string {
	t.Helper()

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}

	var sources []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		sources = append(sources, filepath.Join(".", name))
	}
	return sources
}

// mutations reports every call to a mutating verb in one file, as
// "position: verb" lines.
func mutations(fset *token.FileSet, file *ast.File) []string {
	var found []string

	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if slices.Contains(mutatingVerbs, selector.Sel.Name) {
			found = append(found, fset.Position(selector.Sel.Pos()).String()+" calls "+selector.Sel.Name)
		}
		return true
	})

	return found
}

// The gate has to fail on the thing it exists to catch. Without this, a
// selector walk that quietly stopped matching would report a clean package
// forever.
func TestReadOnlyGateDetectsAMutatingCall(t *testing.T) {
	for _, verb := range mutatingVerbs {
		t.Run(verb, func(t *testing.T) {
			found := mutations(parseSample(t, "package sample\n\nfunc f(c client) { c."+verb+"(nil) }\n"))
			if len(found) != 1 {
				t.Errorf("found %v, want exactly one finding for %s", found, verb)
			}
		})
	}
}

// And it has to accept the calls the package actually makes, or it would be a
// gate nobody could work under.
func TestReadOnlyGateAcceptsReads(t *testing.T) {
	const src = `package sample

func f(c client) {
	c.List(nil)
	c.Watch(nil)
	c.Get(nil)
	c.Namespace("x").List(nil)
}
`
	if found := mutations(parseSample(t, src)); len(found) != 0 {
		t.Errorf("found %v, want none: these are the calls the package is built out of", found)
	}
}

// parseSample parses a source string for the two gate self-tests.
func parseSample(t *testing.T, src string) (*token.FileSet, *ast.File) {
	t.Helper()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "sample.go", src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parsing the sample: %v", err)
	}
	return fset, file
}
