package main_test

import (
	"fmt"
	"go/ast"
	"sort"
	"strings"
	"testing"
)

// exportedNames returns the exported package-scope identifiers declared across
// files: the top-level funcs, types, vars and consts another package can name.
//
// Methods and struct fields live in a type's scope rather than the package's,
// so they are not counted here — the god-object gate bounds those. Each name in
// a grouped var/const block counts separately, because each is independently
// referenceable.
func exportedNames(files []*ast.File) []string {
	var names []string
	for _, file := range files {
		for _, decl := range file.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				// A method belongs to its receiver's scope, not the package's.
				if _, isMethod := receiverTypeName(d); isMethod {
					continue
				}
				if d.Name.IsExported() {
					names = append(names, d.Name.Name)
				}
			case *ast.GenDecl:
				names = append(names, exportedSpecNames(d)...)
			}
		}
	}
	sort.Strings(names)
	return names
}

// exportedSpecNames returns the exported names declared by a type, var or
// const declaration.
func exportedSpecNames(decl *ast.GenDecl) []string {
	var names []string
	for _, spec := range decl.Specs {
		switch s := spec.(type) {
		case *ast.TypeSpec:
			if s.Name.IsExported() {
				names = append(names, s.Name.Name)
			}
		case *ast.ValueSpec:
			for _, ident := range s.Names {
				if ident.IsExported() {
					names = append(names, ident.Name)
				}
			}
		}
	}
	return names
}

// TestPackageExportedSurfaceBudget fails when a package exports more top-level
// identifiers than its pin allows.
//
// This is the seam-width gate. All m6t code lives under internal/, so an
// exported name is not a semver commitment — but it is still the surface other
// packages couple to, and a seam that widens unnoticed is how one service
// becomes everyone's dependency. Shrink the surface (unexport the helper, take
// an interface) rather than raising the pin.
func TestPackageExportedSurfaceBudget(t *testing.T) {
	var violations []string
	for _, dir := range packageDirs(t) {
		pin, pinned := structuralPins[dir]
		if !pinned {
			continue // reported by TestEveryPackageIsPinned
		}
		names := exportedNames(parsePackage(t, dir))
		t.Logf("%-20s %d exported (ceiling %d): %s",
			dir, len(names), pin.exported, strings.Join(names, " "))
		if len(names) > pin.exported {
			violations = append(violations, fmt.Sprintf(
				"%s exports %d identifiers (%s), exceeding its pin of %d — unexport what callers do not need, or justify the wider seam in this PR",
				dir, len(names), strings.Join(names, ", "), pin.exported))
		}
	}
	sort.Strings(violations)

	if len(violations) > 0 {
		t.Errorf("exported-surface budget exceeded:\n  %s", strings.Join(violations, "\n  "))
	}
}

// TestExportedNamesCountsPackageScopeOnly pins the metric itself. Without it, a
// refactor that quietly started counting methods, or stopped counting grouped
// consts, would move every measurement at once and still look green.
func TestExportedNamesCountsPackageScopeOnly(t *testing.T) {
	const src = `package sample

type Exported struct{ Field int }
type unexported struct{}

func (e Exported) Method() {}
func (e *Exported) PointerMethod() {}

func Fn() {}
func fn() {}

const (
	ConstA = 1
	ConstB = 2
	constC = 3
)

var VarA, varB = 1, 2
`
	want := []string{"ConstA", "ConstB", "Exported", "Fn", "VarA"}
	got := exportedNames([]*ast.File{parseSource(t, src)})

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("exported names = %v, want %v", got, want)
	}
}
