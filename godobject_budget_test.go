package main_test

import (
	"go/ast"
	"testing"
)

// The god-object gate. The package-size budget is gameable in exactly the
// direction that matters here: moving code out of app.go into sibling files
// shrinks the line count while the App struct keeps every field and every
// method. This gate caps the struct itself.
//
// App is m6t's coordinator. Wails binds it to the frontend and it composes the
// backend services (git, pty, kube, helm; DESIGN.md §3.2) as they land, so it
// is the one type in the tree that everything else will be reachable through —
// which is precisely why it needs a ceiling from day one rather than after it
// has grown into a decomposition project.
//
// Run: go test -run TestAppGodObjectBudget .
const (
	// maxAppFields caps fields on the App struct. Pinned at today's actual
	// with zero slack.
	//
	// This ceiling WILL need raising as backend services land, and that is the
	// design: each service arrives as one composed handle, in a PR that says so
	// on this line. What it stops is the accumulation nobody decided on — six
	// loose fields where one owner struct belonged. If raising it by more than
	// one per service, the question to answer in review is why the service is
	// not one handle.
	maxAppFields = 1

	// maxAppMethods caps methods with an App receiver, counting value and
	// pointer receivers alike. Pinned at today's actual with zero slack.
	//
	// Every exported method here is also Wails-bound API — it crosses the
	// bridge into TypeScript — so this ceiling doubles as the budget on the
	// backend's public surface. Behavior belongs on the service that owns it,
	// reached through a handle, not on the coordinator.
	maxAppMethods = 1

	// appCoordinatorType is the struct these ceilings bound.
	appCoordinatorType = "App"

	// appPackageDir holds the coordinator.
	appPackageDir = "internal/app"
)

// TestAppGodObjectBudget fails when the coordinator gains fields or methods
// beyond the pinned ceilings. Unlike a line-count budget these numbers cannot
// be satisfied by shuffling code between files: they only come down through
// real decomposition — moving state and behavior onto the service that owns
// it.
func TestAppGodObjectBudget(t *testing.T) {
	fields, methods := countCoordinator(t)
	t.Logf("%s coordinator: %d fields, %d methods (ceilings %d / %d)",
		appCoordinatorType, fields, methods, maxAppFields, maxAppMethods)

	if fields > maxAppFields {
		t.Errorf("%s has %d fields, exceeding the ceiling of %d — group the new state into a service handle rather than holding it directly, or justify the raise on maxAppFields in this PR",
			appCoordinatorType, fields, maxAppFields)
	}
	if methods > maxAppMethods {
		t.Errorf("%s has %d methods, exceeding the ceiling of %d — move behavior onto the service that owns it (and remember every exported method here is also Wails-bound API), or justify the raise on maxAppMethods in this PR",
			appCoordinatorType, methods, maxAppMethods)
	}
}

// countCoordinator parses the coordinator's package and returns the struct's
// field count and the number of methods declared on it.
func countCoordinator(t *testing.T) (fields, methods int) {
	t.Helper()
	files := parsePackage(t, appPackageDir)

	found := false
	for _, file := range files {
		for _, decl := range file.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if name, ok := receiverTypeName(d); ok && name == appCoordinatorType {
					methods++
				}
			case *ast.GenDecl:
				if n, ok := structFieldCount(d, appCoordinatorType); ok {
					fields = n
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatalf("did not find `type %s struct` in %s — if the coordinator was renamed, retarget this gate rather than deleting it",
			appCoordinatorType, appPackageDir)
	}
	return fields, methods
}

// structFieldCount returns the field count of the named struct, counting each
// name in a grouped declaration (`a, b int` is two) and each embedded field as
// one. The bool is false for any declaration that is not that struct.
//
// Embedded fields count deliberately: embedding a struct to inherit its
// methods is a way of growing the coordinator without naming a field.
func structFieldCount(decl *ast.GenDecl, typeName string) (int, bool) {
	for _, spec := range decl.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok || ts.Name.Name != typeName {
			continue
		}
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			continue
		}
		count := 0
		for _, field := range st.Fields.List {
			if len(field.Names) == 0 {
				count++ // embedded
				continue
			}
			count += len(field.Names)
		}
		return count, true
	}
	return 0, false
}

// TestGodObjectMetricCountsGroupedAndEmbeddedFields pins the metric. A field
// counter that missed grouped or embedded declarations would let the
// coordinator grow while reporting a flat number — the failure mode that makes
// a ratchet worthless.
func TestGodObjectMetricCountsGroupedAndEmbeddedFields(t *testing.T) {
	const src = `package sample

type Embedded struct{}

type Target struct {
	a, b int
	c    string
	Embedded
}

type Other struct{ x, y, z int }

func (t *Target) PointerMethod() {}
func (t Target) ValueMethod()    {}
func (o *Other) NotCounted()     {}
func Free()                      {}
`
	file := parseSource(t, src)

	fields, found := 0, false
	methods := 0
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if name, ok := receiverTypeName(d); ok && name == "Target" {
				methods++
			}
		case *ast.GenDecl:
			if n, ok := structFieldCount(d, "Target"); ok {
				fields, found = n, true
			}
		}
	}

	if !found {
		t.Fatal("structFieldCount did not find the Target struct")
	}
	// a, b, c, and the embedded field.
	if want := 4; fields != want {
		t.Errorf("fields = %d, want %d (grouped names and embedded fields each count)", fields, want)
	}
	// Both receiver forms count; the other type's method and the free function do not.
	if want := 2; methods != want {
		t.Errorf("methods = %d, want %d (value and pointer receivers both count)", methods, want)
	}
}
