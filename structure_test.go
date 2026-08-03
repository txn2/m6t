// Structural ratchets: gates that make architectural decay a test failure
// rather than a review opinion.
//
// The per-function linters (gocyclo, gocognit, revive) all evaluate code INSIDE
// one function, so a god-package assembled from a hundred small, tidy functions
// passes every one of them. These tests bound the shapes those linters cannot
// see: how big a package is, how much it exports, how many packages exist, what
// depends on what, and how much state the coordinator holds.
//
// Ceilings only move DOWN. Raising one is a regression that must be justified
// in the PR that raises it — that justification, written next to the number, is
// the whole mechanism. There is no suppression comment and no escape hatch.
//
// This file holds the shared source-tree analysis the gates are built on.
package main_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path"
	"strconv"
	"strings"
	"testing"
)

// modulePath is this module's import path. Import paths under it are
// first-party; everything else is a dependency.
const modulePath = "github.com/txn2/m6t"

// rootPackageDir is how the main package's directory is spelled in the
// repo-relative paths these gates use.
const rootPackageDir = "."

// skipDir reports whether a directory holds no first-party Go source and
// should be pruned from every walk.
//
// frontend/node_modules matters specifically: npm packages ship Go source
// (flatted/golang), and counting a dependency's code as m6t's would corrupt
// every measurement here. go.mod's `ignore` directive keeps it out of the
// build for the same reason.
// The skipped names match what the go tool itself excludes from a package
// walk, so a directory these gates ignore is one the compiler ignores too.
// Anything else — including build/, which holds packaging assets today — stays
// in the walk: a directory pruned here is a directory where a package could
// live outside every ceiling in this file.
func skipDir(name string) bool {
	switch name {
	case "node_modules", "vendor", "testdata":
		return true
	}
	// .git, .github, .semgrep and friends: no first-party Go source, and the
	// go tool skips dot-prefixed directories for the same reason.
	return strings.HasPrefix(name, ".") && name != rootPackageDir
}

// goSourceFile reports whether name is hand-written, non-test Go source.
func goSourceFile(name string) bool {
	return strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go")
}

// walkGoSource calls visit for every hand-written, non-test .go file in the
// module, passing the file's repo-relative slash path and the directory that
// holds it (the root package's directory is ".").
func walkGoSource(t *testing.T, visit func(file, dir string)) {
	t.Helper()
	err := fs.WalkDir(repoFS, rootPackageDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != rootPackageDir && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !goSourceFile(d.Name()) {
			return nil
		}
		dir := path.Dir(p)
		if dir == "" {
			dir = rootPackageDir
		}
		visit(p, dir)
		return nil
	})
	if err != nil {
		t.Fatalf("walking the module for Go source: %v", err)
	}
}

// packageDirs returns every directory holding hand-written, non-test Go
// source, as repo-relative slash paths.
func packageDirs(t *testing.T) []string {
	t.Helper()
	seen := map[string]bool{}
	var dirs []string
	walkGoSource(t, func(_, dir string) {
		if !seen[dir] {
			seen[dir] = true
			dirs = append(dirs, dir)
		}
	})
	if len(dirs) == 0 {
		t.Fatal("found no first-party Go packages; the walk is broken, not the tree")
	}
	return dirs
}

// parsePackage parses every hand-written, non-test file in dir.
func parsePackage(t *testing.T, dir string) []*ast.File {
	t.Helper()
	fset := token.NewFileSet()
	var files []*ast.File
	walkGoSource(t, func(file, fileDir string) {
		if fileDir != dir {
			return
		}
		src, err := fs.ReadFile(repoFS, file)
		if err != nil {
			t.Fatalf("reading %s: %v", file, err)
		}
		parsed, err := parser.ParseFile(fset, file, src, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parsing %s: %v", file, err)
		}
		files = append(files, parsed)
	})
	if len(files) == 0 {
		t.Fatalf("no non-test Go files found in %s", dir)
	}
	return files
}

// parseSource parses a Go source literal. The gates' metrics are unit-tested
// against literals so their behaviour is pinned without adding fixture
// packages to the module — which the dead-package gate would rightly reject.
func parseSource(t *testing.T, src string) *ast.File {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "fixture.go", src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parsing fixture source: %v", err)
	}
	return file
}

// importDir maps a first-party import path to the repo-relative directory that
// holds it, reporting false for third-party imports.
func importDir(importPath string) (string, bool) {
	if importPath == modulePath {
		return rootPackageDir, true
	}
	rest, ok := strings.CutPrefix(importPath, modulePath+"/")
	if !ok {
		return "", false
	}
	return rest, true
}

// firstPartyImports returns the first-party import graph: each package
// directory mapped to the set of package directories it imports from
// non-test code.
//
// Non-test code only, deliberately. A package reachable solely from a test is
// not wired into the app; that is exactly what the dead-package gate exists to
// catch, and counting test imports would hide it.
func firstPartyImports(t *testing.T) map[string]map[string]bool {
	t.Helper()
	graph := map[string]map[string]bool{}
	for _, dir := range packageDirs(t) {
		deps := map[string]bool{}
		for _, file := range parsePackage(t, dir) {
			for _, spec := range file.Imports {
				importPath, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					t.Fatalf("unquoting import %s in %s: %v", spec.Path.Value, dir, err)
				}
				if dep, ok := importDir(importPath); ok {
					deps[dep] = true
				}
			}
		}
		graph[dir] = deps
	}
	return graph
}

// reachableFromMain returns the set of package directories reachable from the
// main package through non-test imports — the packages that actually ship in
// the binary.
func reachableFromMain(t *testing.T, graph map[string]map[string]bool) map[string]bool {
	t.Helper()
	if _, ok := graph[rootPackageDir]; !ok {
		t.Fatal("the module has no root main package; the entrypoint gates cannot run")
	}
	reached := map[string]bool{rootPackageDir: true}
	queue := []string{rootPackageDir}
	for len(queue) > 0 {
		dir := queue[0]
		queue = queue[1:]
		for dep := range graph[dir] {
			if !reached[dep] {
				reached[dep] = true
				queue = append(queue, dep)
			}
		}
	}
	return reached
}

// receiverTypeName returns the name of fn's receiver type, unwrapping a
// pointer receiver. Counting value receivers alongside pointer ones closes an
// escape hatch: a method ceiling that only saw `func (a *App)` could be ducked
// by rewriting the receiver as `func (a App)` with no real decomposition.
func receiverTypeName(fn *ast.FuncDecl) (string, bool) {
	if fn.Recv == nil || len(fn.Recv.List) != 1 {
		return "", false
	}
	recv := fn.Recv.List[0].Type
	if star, ok := recv.(*ast.StarExpr); ok {
		recv = star.X
	}
	ident, ok := recv.(*ast.Ident)
	if !ok {
		return "", false
	}
	return ident.Name, true
}
