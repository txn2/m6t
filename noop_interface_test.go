package main_test

import (
	"fmt"
	"go/ast"
	"sort"
	"strings"
	"testing"
)

// The no-op interface gate.
//
// The smell: an interface is declared, one type implements it, and every method
// of that implementation does nothing. The interface exists so a dependency can
// be "injected" and a test can assert the no-op was called — coverage goes up,
// nothing is verified. It is the structural form of the tautological test that
// CLAUDE.md bans, and mutation testing cannot catch it because there is no
// behavior to mutate.
//
// Detection is by method-name set rather than full type checking: a type
// implements an interface here if its method names are a superset of the
// interface's. That is an approximation, and it is the conservative direction —
// a false positive needs a type that both shares every method name with an
// interface AND has nothing but empty bodies, which is itself the thing this
// gate is looking for.
//
// Run: go test -run TestNoNoopOnlyInterfaces .

// methodBody describes one method for the purposes of this gate.
type methodBody struct {
	name  string
	isNop bool
}

// TestNoNoopOnlyInterfaces fails when every implementation of a first-party
// interface does nothing.
func TestNoNoopOnlyInterfaces(t *testing.T) {
	interfaces, implementations := collectInterfacesAndImplementations(t)

	var violations []string
	for name, required := range interfaces {
		implementers, allNop := classifyImplementations(required, implementations)
		if len(implementers) == 0 || !allNop {
			continue
		}
		sort.Strings(implementers)
		violations = append(violations, fmt.Sprintf(
			"interface %s is satisfied only by no-op implementations (%s) — either give it a real implementation or delete it; an interface whose only implementation does nothing launders coverage without verifying behavior",
			name, strings.Join(implementers, ", ")))
	}
	sort.Strings(violations)

	if len(violations) > 0 {
		t.Errorf("no-op interface detected:\n  %s", strings.Join(violations, "\n  "))
	}
}

// collectInterfacesAndImplementations scans first-party non-test source for
// interface declarations (name to its method-name set) and for named types
// with methods (name to those methods).
func collectInterfacesAndImplementations(t *testing.T) (interfaces map[string][]string, implementations map[string][]methodBody) {
	t.Helper()
	interfaces = map[string][]string{}
	implementations = map[string][]methodBody{}

	for _, dir := range packageDirs(t) {
		for _, file := range parsePackage(t, dir) {
			for _, decl := range file.Decls {
				switch d := decl.(type) {
				case *ast.GenDecl:
					for name, methods := range interfaceMethodNames(d) {
						interfaces[dir+"."+name] = methods
					}
				case *ast.FuncDecl:
					recv, ok := receiverTypeName(d)
					if !ok {
						continue
					}
					key := dir + "." + recv
					implementations[key] = append(implementations[key], methodBody{
						name:  d.Name.Name,
						isNop: isNoopBody(d),
					})
				}
			}
		}
	}
	return interfaces, implementations
}

// interfaceMethodNames returns the method names of each interface type declared
// by decl. Embedded interfaces are skipped: their methods are not named here,
// and an interface built only from embeddings is not the smell being detected.
func interfaceMethodNames(decl *ast.GenDecl) map[string][]string {
	found := map[string][]string{}
	for _, spec := range decl.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok {
			continue
		}
		it, ok := ts.Type.(*ast.InterfaceType)
		if !ok {
			continue
		}
		var names []string
		for _, field := range it.Methods.List {
			if _, isFunc := field.Type.(*ast.FuncType); !isFunc {
				continue // embedded interface or a type constraint element
			}
			for _, ident := range field.Names {
				names = append(names, ident.Name)
			}
		}
		if len(names) > 0 {
			found[ts.Name.Name] = names
		}
	}
	return found
}

// classifyImplementations returns the types whose method sets cover required,
// and whether every one of them implements all of those methods as no-ops.
func classifyImplementations(required []string, implementations map[string][]methodBody) (implementers []string, allNop bool) {
	allNop = true
	for typeName, methods := range implementations {
		byName := map[string]methodBody{}
		for _, m := range methods {
			byName[m.name] = m
		}
		if !covers(byName, required) {
			continue
		}
		implementers = append(implementers, typeName)
		for _, name := range required {
			if !byName[name].isNop {
				allNop = false
			}
		}
	}
	return implementers, allNop
}

// covers reports whether byName holds every required method.
func covers(byName map[string]methodBody, required []string) bool {
	for _, name := range required {
		if _, ok := byName[name]; !ok {
			return false
		}
	}
	return true
}

// isNoopBody reports whether a method does nothing observable: an empty body,
// or a single return of nothing but literals and nil. A body that calls
// anything, assigns anything, or returns a computed value is real.
func isNoopBody(fn *ast.FuncDecl) bool {
	if fn.Body == nil {
		return true // declared without a body (assembly or external linkage)
	}
	if len(fn.Body.List) == 0 {
		return true
	}
	if len(fn.Body.List) > 1 {
		return false
	}
	ret, ok := fn.Body.List[0].(*ast.ReturnStmt)
	if !ok {
		return false
	}
	for _, result := range ret.Results {
		if !isZeroValueExpr(result) {
			return false
		}
	}
	return true
}

// isZeroValueExpr reports whether e is a literal or the identifier nil — the
// things a stub returns when it has nothing to say.
func isZeroValueExpr(e ast.Expr) bool {
	switch v := e.(type) {
	case *ast.BasicLit:
		return true
	case *ast.Ident:
		return v.Name == "nil" || v.Name == "true" || v.Name == "false"
	case *ast.CompositeLit:
		return len(v.Elts) == 0
	default:
		return false
	}
}

// TestNoopDetectionDistinguishesStubsFromBehavior pins the classifier. A
// detector that called everything a no-op would fail every honest interface;
// one that called nothing a no-op would never fire. Both look like a working
// gate from the outside, which is why the classifier is tested directly.
func TestNoopDetectionDistinguishesStubsFromBehavior(t *testing.T) {
	const src = `package sample

type T struct{}

func (T) EmptyBody()            {}
func (T) BareReturn()           { return }
func (T) ReturnsNil() error     { return nil }
func (T) ReturnsLiteral() int   { return 0 }
func (T) ReturnsEmptyStruct() S { return S{} }
func (T) CallsSomething() error { return doWork() }
func (T) Assigns() int          { x := 1; return x }
func (T) TwoStatements() error  { log(); return nil }
`
	want := map[string]bool{
		"EmptyBody":          true,
		"BareReturn":         true,
		"ReturnsNil":         true,
		"ReturnsLiteral":     true,
		"ReturnsEmptyStruct": true,
		"CallsSomething":     false,
		"Assigns":            false,
		"TwoStatements":      false,
	}

	for _, decl := range parseSource(t, src).Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		expected, known := want[fn.Name.Name]
		if !known {
			t.Fatalf("fixture method %s has no expectation", fn.Name.Name)
		}
		if got := isNoopBody(fn); got != expected {
			t.Errorf("isNoopBody(%s) = %v, want %v", fn.Name.Name, got, expected)
		}
	}
}

// TestNoopInterfaceGateFires proves the gate reports a no-op-only interface and
// stays quiet for one with a real implementation. Without this the gate could
// be permanently vacuous — there are no interfaces in the tree yet — and nobody
// would know until it failed to catch the first one.
func TestNoopInterfaceGateFires(t *testing.T) {
	required := []string{"Do"}

	stubs := map[string][]methodBody{
		"internal/x.Stub": {{name: "Do", isNop: true}},
	}
	implementers, allNop := classifyImplementations(required, stubs)
	if len(implementers) != 1 || !allNop {
		t.Errorf("a stub-only implementation should be reported: implementers=%v allNop=%v", implementers, allNop)
	}

	mixed := map[string][]methodBody{
		"internal/x.Stub": {{name: "Do", isNop: true}},
		"internal/x.Real": {{name: "Do", isNop: false}},
	}
	implementers, allNop = classifyImplementations(required, mixed)
	if len(implementers) != 2 || allNop {
		t.Errorf("a real implementation alongside a stub must clear the gate: implementers=%v allNop=%v", implementers, allNop)
	}

	unrelated := map[string][]methodBody{
		"internal/x.Other": {{name: "SomethingElse", isNop: true}},
	}
	if implementers, _ := classifyImplementations(required, unrelated); len(implementers) != 0 {
		t.Errorf("a type that does not cover the interface is not an implementation: %v", implementers)
	}
}
