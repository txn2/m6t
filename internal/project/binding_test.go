package project

import (
	"errors"
	"reflect"
	"testing"
)

// devAndProd is the layout the scope mechanism exists for: one directory per
// cluster, one directory per namespace beneath it (DESIGN.md §4).
func devAndProd() Kube {
	return Kube{
		Context:   "prod-us-west",
		Namespace: "default",
		Scopes: []Scope{
			{Path: "dev", Context: "dev-cluster", Namespace: "dev"},
			{Path: "prod", Protected: true},
			{Path: "prod/api", Namespace: "api"},
		},
	}
}

func TestResolveWalksScopesDeepestFirst(t *testing.T) {
	t.Parallel()

	binding := devAndProd()

	tests := []struct {
		name string
		rel  string
		want Binding
	}{
		{
			name: "the project root falls back to the project default",
			rel:  "",
			want: Binding{Context: "prod-us-west", Namespace: "default"},
		},
		{
			name: "a path in no scope keeps the project default",
			rel:  "docs/README.md",
			want: Binding{Context: "prod-us-west", Namespace: "default"},
		},
		{
			name: "a scope replaces both fields it sets",
			rel:  "dev/api/deployment.yaml",
			want: Binding{Context: "dev-cluster", Namespace: "dev", Scope: "dev"},
		},
		{
			name: "a scope setting only protected inherits context and namespace",
			rel:  "prod/web/deployment.yaml",
			want: Binding{Context: "prod-us-west", Namespace: "default", Protected: true, Scope: "prod"},
		},
		{
			name: "a deeper scope overrides namespace and inherits its parent's protection",
			rel:  "prod/api/deployment.yaml",
			want: Binding{Context: "prod-us-west", Namespace: "api", Protected: true, Scope: "prod/api"},
		},
		{
			name: "the scope directory itself resolves like its contents",
			rel:  "prod/api",
			want: Binding{Context: "prod-us-west", Namespace: "api", Protected: true, Scope: "prod/api"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := binding.Resolve(test.rel); got != test.want {
				t.Errorf("Resolve(%q) = %+v, want %+v", test.rel, got, test.want)
			}
		})
	}
}

// The order scopes are stored in must not decide the answer: projects.yaml is
// hand-editable (DESIGN.md §4), and a binding that depended on which line came
// first would change cluster when a user tidied their config.
func TestResolveIgnoresScopeOrder(t *testing.T) {
	t.Parallel()

	forward := devAndProd()
	reversed := devAndProd()
	reversed.Scopes = []Scope{
		{Path: "prod/api", Namespace: "api"},
		{Path: "prod", Protected: true},
		{Path: "dev", Context: "dev-cluster", Namespace: "dev"},
	}

	for _, rel := range []string{"prod/api/x.yaml", "prod/web/x.yaml", "dev/x.yaml"} {
		if got, want := reversed.Resolve(rel), forward.Resolve(rel); got != want {
			t.Errorf("Resolve(%q) with scopes reversed = %+v, want %+v", rel, got, want)
		}
	}
}

// A scope matches whole path segments. `prod` covering `production` would be a
// directory silently inheriting a neighbour's cluster, which is the failure the
// binding exists to prevent.
func TestResolveMatchesWholeSegments(t *testing.T) {
	t.Parallel()

	binding := Kube{
		Context:   "shared",
		Namespace: "default",
		Scopes:    []Scope{{Path: "prod", Context: "prod-cluster", Protected: true}},
	}

	got := binding.Resolve("production/deployment.yaml")
	want := Binding{Context: "shared", Namespace: "default"}
	if got != want {
		t.Errorf("Resolve on a sibling with a shared prefix = %+v, want the project default %+v", got, want)
	}
}

// Protection ratchets on and can never be turned off by going deeper. A tree
// walk that could disarm confirmation from a config file would undo the app's
// most important safety feature (DESIGN.md §5).
func TestResolveProtectionOnlyRatchetsOn(t *testing.T) {
	t.Parallel()

	binding := Kube{
		Context:   "prod",
		Namespace: "default",
		Protected: true,
		Scopes:    []Scope{{Path: "sandbox", Namespace: "sandbox"}},
	}

	if got := binding.Resolve("sandbox/x.yaml"); !got.Protected {
		t.Errorf("Resolve under a protected project = %+v, want protection retained", got)
	}
}

func TestResolveNormalizesTheQueriedPath(t *testing.T) {
	t.Parallel()

	binding := devAndProd()
	want := binding.Resolve("dev/api")

	// Windows separators are included because the tree reports what the OS
	// gives it, and a scope typed with slashes has to match either.
	for _, rel := range []string{"./dev/api", "dev/api/", "dev//api", `dev\api`, "dev/./api"} {
		if got := binding.Resolve(rel); got != want {
			t.Errorf("Resolve(%q) = %+v, want %+v", rel, got, want)
		}
	}
}

// A path that climbs out of the repository belongs to no subtree, so it gets
// the project default rather than a scope's binding.
func TestResolveIgnoresScopesForPathsAboveTheRoot(t *testing.T) {
	t.Parallel()

	binding := devAndProd()

	got := binding.Resolve("../elsewhere/x.yaml")
	want := Binding{Context: "prod-us-west", Namespace: "default"}
	if got != want {
		t.Errorf("Resolve above the root = %+v, want the project default %+v", got, want)
	}
}

// A scope with an empty path cannot be written through the UI — validateScopes
// refuses it — but a hand-edited projects.yaml can hold one, and DESIGN.md §4
// makes editing that file by hand supported. It covers the whole repository,
// which is the only reading that makes sense for "the root subtree".
func TestResolveAppliesARootScopeFromAHandEditedFile(t *testing.T) {
	t.Parallel()

	binding := Kube{
		Context:   "prod-us-west",
		Namespace: "default",
		Scopes:    []Scope{{Path: "", Namespace: "everything"}},
	}

	for _, rel := range []string{"", "dev/x.yaml", "deep/nested/path.yaml"} {
		if got := binding.Resolve(rel); got.Namespace != "everything" {
			t.Errorf("Resolve(%q) = %+v, want the root scope applied", rel, got)
		}
	}
}

func TestBoundRequiresBothHalves(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		binding Binding
		want    bool
	}{
		{name: "both set", binding: Binding{Context: "c", Namespace: "n"}, want: true},
		{name: "no namespace", binding: Binding{Context: "c"}, want: false},
		{name: "no context", binding: Binding{Namespace: "n"}, want: false},
		{name: "neither", binding: Binding{}, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := test.binding.Bound(); got != test.want {
				t.Errorf("Bound() on %+v = %v, want %v", test.binding, got, test.want)
			}
		})
	}
}

func TestValidateScopesNormalizesPaths(t *testing.T) {
	t.Parallel()

	got, err := validateScopes(Kube{Scopes: []Scope{
		{Path: " ./prod/api/ ", Context: " prod-us-west ", Namespace: " api "},
		{Path: `dev\api`},
	}})
	if err != nil {
		t.Fatalf("validateScopes: %v", err)
	}

	want := []Scope{
		{Path: "prod/api", Context: "prod-us-west", Namespace: "api"},
		{Path: "dev/api"},
	}
	if !reflect.DeepEqual(got.Scopes, want) {
		t.Errorf("normalized scopes = %+v, want %+v", got.Scopes, want)
	}
}

// An empty scope list is stored as nil so `omitempty` drops the key: a
// projects.yaml that grew `scopes: []` the first time the settings dialog was
// opened would be the app editing a file for no reason.
func TestValidateScopesDropsAnEmptyList(t *testing.T) {
	t.Parallel()

	got, err := validateScopes(Kube{Context: "prod", Scopes: []Scope{}})
	if err != nil {
		t.Fatalf("validateScopes: %v", err)
	}
	if got.Scopes != nil {
		t.Errorf("empty scope list stored as %#v, want nil", got.Scopes)
	}
	if got.Context != "prod" {
		t.Errorf("validateScopes changed the context to %q", got.Context)
	}
}

func TestValidateScopesRefusesPathsOutsideTheRepository(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		path string
	}{
		{name: "absolute", path: "/etc/kubernetes"},
		{name: "parent traversal", path: "../secrets"},
		{name: "traversal that climbs out after cleaning", path: "prod/../../secrets"},
		{name: "bare parent", path: ".."},
		{name: "empty", path: "  "},
		{name: "the root itself", path: "."},
		{name: "a windows absolute path", path: `\etc\kubernetes`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := validateScopes(Kube{Scopes: []Scope{{Path: test.path}}}); !errors.Is(err, ErrInvalidScope) {
				t.Errorf("validateScopes(%q) error = %v, want ErrInvalidScope", test.path, err)
			}
		})
	}
}

// Two rules for one subtree have no winner a user could predict, so the write
// is refused rather than resolved by position.
func TestValidateScopesRefusesDuplicates(t *testing.T) {
	t.Parallel()

	_, err := validateScopes(Kube{Scopes: []Scope{
		{Path: "prod", Namespace: "a"},
		{Path: "./prod/", Namespace: "b"},
	}})
	if !errors.Is(err, ErrInvalidScope) {
		t.Errorf("validateScopes with a duplicate scope error = %v, want ErrInvalidScope", err)
	}
}

// Server-side apply is the project's answer for the whole repository. A scope
// that set it would give one repository two field-manager histories for the
// same objects, so Resolve carries it through unchanged from the project no
// matter how deep the matching scope is.
func TestResolveCarriesServerSideFromTheProjectAlone(t *testing.T) {
	t.Parallel()

	kube := Kube{
		Context:    "dev",
		Namespace:  "default",
		ServerSide: true,
		Scopes: []Scope{
			{Path: "prod", Context: "prod-us-west", Namespace: "platform", Protected: true},
		},
	}

	for _, rel := range []string{"", "prod", "prod/api/deploy.yaml"} {
		if got := kube.Resolve(rel); !got.ServerSide {
			t.Errorf("Resolve(%q).ServerSide = false, want the project's own true", rel)
		}
	}

	off := kube
	off.ServerSide = false
	if got := off.Resolve("prod/api"); got.ServerSide {
		t.Error("Resolve().ServerSide = true for a project that has it off")
	}
}
