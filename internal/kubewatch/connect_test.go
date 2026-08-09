package kubewatch

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// apiServer stands in for a cluster's discovery endpoints, which is all Connect
// touches: it builds clients and asks what the cluster serves, and does not
// read an object.
//
// Serving real discovery documents rather than stubbing the discovery client is
// what makes this test worth having. The mapping from a manifest's apiVersion
// and kind to a resource path is client-go's to compute from these documents,
// and a stub would assert that m6t passes its own answer through.
func apiServer(t *testing.T) string {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api", serveJSON(t, &metav1.APIVersions{Versions: []string{"v1"}}))
	mux.HandleFunc("/api/v1", serveJSON(t, &metav1.APIResourceList{
		GroupVersion: "v1",
		APIResources: []metav1.APIResource{
			{Name: "services", SingularName: "service", Namespaced: true, Kind: "Service"},
			{Name: "namespaces", SingularName: "namespace", Namespaced: false, Kind: "Namespace"},
		},
	}))
	mux.HandleFunc("/apis", serveJSON(t, &metav1.APIGroupList{Groups: []metav1.APIGroup{{
		Name:             "apps",
		Versions:         []metav1.GroupVersionForDiscovery{{GroupVersion: "apps/v1", Version: "v1"}},
		PreferredVersion: metav1.GroupVersionForDiscovery{GroupVersion: "apps/v1", Version: "v1"},
	}}}))
	mux.HandleFunc("/apis/apps/v1", serveJSON(t, &metav1.APIResourceList{
		GroupVersion: "apps/v1",
		APIResources: []metav1.APIResource{
			{Name: "deployments", SingularName: "deployment", Namespaced: true, Kind: "Deployment"},
		},
	}))

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL
}

func serveJSON(t *testing.T, body any) http.HandlerFunc {
	t.Helper()

	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(body); err != nil {
			t.Errorf("encoding a discovery document: %v", err)
		}
	}
}

// kubeconfig writes a config naming two contexts against server and points
// KUBECONFIG at it.
//
// Two contexts, because the property under test is that Connect uses the one it
// is given: a single-context file would pass whether the override worked or the
// current-context was read.
func kubeconfig(t *testing.T, server string) {
	t.Helper()

	body := `apiVersion: v1
kind: Config
current-context: other
clusters:
- name: real
  cluster:
    server: ` + server + `
- name: nowhere
  cluster:
    server: https://127.0.0.1:1
contexts:
- name: prod
  context:
    cluster: real
    user: dev
    namespace: shop
- name: other
  context:
    cluster: nowhere
    user: dev
users:
- name: dev
  user: {}
`
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the kubeconfig: %v", err)
	}
	t.Setenv("KUBECONFIG", path)
}

func TestConnectBuildsAMapperFromTheClusterOwnDiscovery(t *testing.T) {
	kubeconfig(t, apiServer(t))

	client, resolver, err := Connect("prod")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if client == nil {
		t.Fatal("Connect returned no dynamic client")
	}

	tests := []struct {
		name       string
		gvk        schema.GroupVersionKind
		wantPath   string
		namespaced bool
	}{
		{
			name:       "a core namespaced kind",
			gvk:        schema.GroupVersionKind{Version: "v1", Kind: "Service"},
			wantPath:   "services",
			namespaced: true,
		},
		{
			name:     "a core cluster-scoped kind",
			gvk:      schema.GroupVersionKind{Version: "v1", Kind: "Namespace"},
			wantPath: "namespaces",
		},
		{
			name:       "a grouped kind",
			gvk:        schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"},
			wantPath:   "deployments",
			namespaced: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mapping, err := resolver.RESTMapping(tt.gvk.GroupKind(), tt.gvk.Version)
			if err != nil {
				t.Fatalf("RESTMapping(%v): %v", tt.gvk, err)
			}
			if mapping.Resource.Resource != tt.wantPath {
				t.Errorf("resource = %q, want %q", mapping.Resource.Resource, tt.wantPath)
			}
			if got := mapping.Scope.Name() == meta.RESTScopeNameNamespace; got != tt.namespaced {
				t.Errorf("namespaced = %v, want %v", got, tt.namespaced)
			}
		})
	}
}

// The kubeconfig's current-context is never consulted (DESIGN.md §4). This
// config's current-context points at an unreachable server, so honoring it
// would fail discovery instead of succeeding against the named one.
func TestConnectIgnoresTheKubeconfigCurrentContext(t *testing.T) {
	kubeconfig(t, apiServer(t))

	if _, _, err := Connect("prod"); err != nil {
		t.Fatalf("Connect(\"prod\"): %v — the current-context was honored instead", err)
	}
}

func TestConnectFailsOnAContextTheKubeconfigDoesNotHave(t *testing.T) {
	kubeconfig(t, apiServer(t))

	_, _, err := Connect("staging")
	if err == nil {
		t.Fatal("Connect on an unknown context returned no error")
	}
	if !strings.Contains(err.Error(), "staging") {
		t.Errorf("error = %q, want it to name the context", err)
	}
}

func TestConnectFailsWhenDiscoveryDoesNotAnswer(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	t.Cleanup(dead.Close)
	kubeconfig(t, dead.URL)

	_, _, err := Connect("prod")
	if err == nil {
		t.Fatal("Connect against a server that fails discovery returned no error")
	}
	if !strings.Contains(err.Error(), "prod") {
		t.Errorf("error = %q, want it to name the context", err)
	}
}

// One aggregated API service being down is an ordinary state in a cluster
// running metrics-server or a mesh. The groups that did answer are enough to
// map every core kind, and refusing to watch anything would make m6t less
// available than the cluster it is looking at.
func TestConnectToleratesAPartialDiscoveryFailure(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api", serveJSON(t, &metav1.APIVersions{Versions: []string{"v1"}}))
	mux.HandleFunc("/api/v1", serveJSON(t, &metav1.APIResourceList{
		GroupVersion: "v1",
		APIResources: []metav1.APIResource{
			{Name: "services", SingularName: "service", Namespaced: true, Kind: "Service"},
		},
	}))
	mux.HandleFunc("/apis", serveJSON(t, &metav1.APIGroupList{Groups: []metav1.APIGroup{{
		Name:             "metrics.k8s.io",
		Versions:         []metav1.GroupVersionForDiscovery{{GroupVersion: "metrics.k8s.io/v1beta1", Version: "v1beta1"}},
		PreferredVersion: metav1.GroupVersionForDiscovery{GroupVersion: "metrics.k8s.io/v1beta1", Version: "v1beta1"},
	}}}))
	mux.HandleFunc("/apis/metrics.k8s.io/v1beta1", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "the server is currently unable to handle the request", http.StatusServiceUnavailable)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	kubeconfig(t, server.URL)

	_, resolver, err := Connect("prod")
	if err != nil {
		t.Fatalf("Connect: %v — one unhealthy API group must not take the whole mapping down", err)
	}

	mapping, err := resolver.RESTMapping(schema.GroupKind{Kind: "Service"}, "v1")
	if err != nil {
		t.Fatalf("RESTMapping for a core kind: %v", err)
	}
	if mapping.Resource.Resource != "services" {
		t.Errorf("resource = %q, want %q", mapping.Resource.Resource, "services")
	}
}
