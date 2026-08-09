package kubewatch

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

// The kinds these tests work in. Two namespaced and one cluster-scoped, which
// is the shape that catches the namespace-resolution mistakes: a cluster-scoped
// object watched inside a namespace is invisible, and a namespaced object
// watched cluster-wide is watched under the wrong RBAC.
var (
	deploymentGVK = schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}
	serviceGVK    = schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Service"}
	namespaceGVK  = schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Namespace"}

	deploymentGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	serviceGVR    = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "services"}
	namespaceGVR  = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}
)

// mapper is the discovery answer these tests stand in for: three kinds, with
// the scopes a real cluster reports for them.
func mapper() meta.RESTMapper {
	m := meta.NewDefaultRESTMapper(nil)
	m.Add(deploymentGVK, meta.RESTScopeNamespace)
	m.Add(serviceGVK, meta.RESTScopeNamespace)
	m.Add(namespaceGVK, meta.RESTScopeRoot)
	return m
}

// cluster builds a fake dynamic client holding objects.
func cluster(objects ...runtime.Object) *dynamicfake.FakeDynamicClient {
	scheme := runtime.NewScheme()
	lists := map[schema.GroupVersionResource]string{
		deploymentGVR: "DeploymentList",
		serviceGVR:    "ServiceList",
		namespaceGVR:  "NamespaceList",
	}
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, lists, objects...)
}

// deployment builds a live Deployment at the given kstatus verdict.
//
// The fields are the ones kstatus actually reads for a Deployment: it compares
// observedGeneration against generation, then the updated/ready/available
// replica counts against spec.replicas. Setting a "status: Current" string
// somewhere would be a fixture that proves the test's own assumption rather
// than the library's behavior.
func deployment(namespace, name string, ready int64) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name": name, "namespace": namespace, "generation": int64(1),
		},
		"spec": map[string]any{"replicas": int64(1)},
		"status": map[string]any{
			"observedGeneration": int64(1),
			"replicas":           int64(1),
			"updatedReplicas":    ready,
			"readyReplicas":      ready,
			"availableReplicas":  ready,
			"conditions": []any{
				map[string]any{"type": "Available", "status": boolString(ready > 0)},
			},
		},
	}}
}

func boolString(v bool) string {
	if v {
		return "True"
	}
	return "False"
}

// service builds a live Service in the bound namespace, which kstatus reports
// Current on existence.
func service(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata":   map[string]any{"name": name, "namespace": "shop"},
		"spec":       map[string]any{"type": "ClusterIP", "clusterIP": "10.0.0.1"},
	}}
}

// namespaceObject builds a live (cluster-scoped) Namespace.
func namespaceObject(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Namespace",
		"metadata":   map[string]any{"name": name},
		"status":     map[string]any{"phase": "Active"},
	}}
}

// declared is a static Manifests seam.
type declared struct {
	mu      sync.Mutex
	objects []Object
	notices []Notice
	err     error
}

func (d *declared) Declared(_, _, _ string) ([]Object, []Notice, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.objects), slices.Clone(d.notices), d.err
}

func (d *declared) set(objects []Object, notices []Notice) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.objects, d.notices = objects, notices
}

// pings counts announcements, so a test can assert the panel was told to look
// again rather than only that the state changed behind it.
type pings struct {
	mu sync.Mutex
	n  int
}

func (p *pings) PublishHealthChanged(string) {
	p.mu.Lock()
	p.n++
	p.mu.Unlock()
}

func (p *pings) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.n
}

// connector returns a Connector serving one fake cluster to every context.
func connector(client dynamic.Interface) Connector {
	return func(string) (dynamic.Interface, meta.RESTMapper, error) {
		return client, mapper(), nil
	}
}

// counter counts connection attempts. It is guarded because the connector runs
// on a session's goroutine and the assertions run on the test's.
type counter struct {
	mu sync.Mutex
	n  int
}

func (c *counter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// counting wraps a Connector so a test can assert how often a session
// reconnected — which is how "this refresh cost nothing" is stated as a fact
// rather than as an absence of visible change.
func counting(connect Connector) (Connector, *counter) {
	tally := &counter{}
	return func(name string) (dynamic.Interface, meta.RESTMapper, error) {
		tally.mu.Lock()
		tally.n++
		tally.mu.Unlock()
		return connect(name)
	}, tally
}

// object is the declaration shorthand these tests read better with.
func object(apiVersion, kind, namespace, name string) Object {
	return Object{
		APIVersion: apiVersion, Kind: kind, Namespace: namespace,
		Name: name, File: strings.ToLower(kind) + ".yaml",
	}
}

// settle polls a service's snapshot until want holds, and fails with what it
// last saw. Polling rather than sleeping a fixed time: the session is a
// goroutine doing real work, and a fixed sleep is either flaky or slow.
func settle(t *testing.T, get func() Snapshot, want func(Snapshot) bool, describe string) Snapshot {
	t.Helper()

	deadline := time.Now().Add(3 * time.Second)
	var last Snapshot
	for time.Now().Before(deadline) {
		last = get()
		if want(last) {
			return last
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s; last snapshot was %+v", describe, last)
	return last
}

// healthy reports whether every object in a snapshot has the given health.
func healthy(want Health) func(Snapshot) bool {
	return func(s Snapshot) bool {
		if len(s.Objects) == 0 {
			return false
		}
		for _, o := range s.Objects {
			if o.Health != want {
				return false
			}
		}
		return true
	}
}

// service builds a Service under test, already aimed, and stops it on cleanup.
func start(t *testing.T, index *declared, connect Connector, events Events) *Service {
	t.Helper()

	svc := New(index, connect, events)
	t.Cleanup(svc.Shutdown)
	svc.Watch("/repo", "prod", "shop")
	return svc
}

func snapshotOf(svc *Service) func() Snapshot {
	return func() Snapshot { return svc.Watch("/repo", "prod", "shop") }
}

func TestWatchReportsLiveHealthForDeclaredObjects(t *testing.T) {
	index := &declared{objects: []Object{
		object("apps/v1", "Deployment", "", "web"),
		object("v1", "Service", "", "web"),
	}}
	svc := start(t, index, connector(cluster(deployment("shop", "web", 1), service("web"))), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthCurrent), "both objects Current")

	if got.Phase != PhaseWatching {
		t.Errorf("phase = %q, want %q", got.Phase, PhaseWatching)
	}
	for _, o := range got.Objects {
		if o.Namespace != "shop" {
			t.Errorf("%s %s namespace = %q, want the binding's namespace resolved in",
				o.Kind, o.Name, o.Namespace)
		}
	}
}

// The manifest's own namespace beats the binding's. A repository that states
// namespaces explicitly must not have them overwritten by whatever folder the
// user happened to select.
func TestWatchPrefersTheNamespaceTheManifestStates(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "other", "web")}}
	svc := start(t, index, connector(cluster(deployment("other", "web", 1))), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthCurrent), "the object in its stated namespace")

	if got.Objects[0].Namespace != "other" {
		t.Errorf("namespace = %q, want %q", got.Objects[0].Namespace, "other")
	}
}

// A cluster-scoped kind has no namespace, and watching one inside the binding's
// namespace would find nothing at all.
func TestWatchResolvesClusterScopedKindsWithoutANamespace(t *testing.T) {
	index := &declared{objects: []Object{object("v1", "Namespace", "", "shop")}}
	svc := start(t, index, connector(cluster(namespaceObject("shop"))), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthCurrent), "the namespace object Current")

	if got.Objects[0].Namespace != "" {
		t.Errorf("namespace = %q, want empty for a cluster-scoped kind", got.Objects[0].Namespace)
	}
}

// "Declared but absent" is the state a never-applied manifest sits in, and the
// most common thing the panel is opened to find out.
func TestWatchReportsNotFoundForAnObjectTheClusterDoesNotHave(t *testing.T) {
	index := &declared{objects: []Object{
		object("apps/v1", "Deployment", "", "web"),
		object("apps/v1", "Deployment", "", "worker"),
	}}
	svc := start(t, index, connector(cluster(deployment("shop", "web", 1))), &pings{})

	got := settle(t, snapshotOf(svc), func(s Snapshot) bool {
		return len(s.Objects) == 2 && s.Objects[0].Health == HealthCurrent
	}, "the applied object Current")

	if got.Objects[1].Health != HealthNotFound {
		t.Errorf("worker health = %q, want %q", got.Objects[1].Health, HealthNotFound)
	}
}

// #12's acceptance criterion: an object deleted out-of-band goes NotFound
// rather than keeping its last-known state.
func TestWatchReportsNotFoundWhenAnObjectIsDeletedOutOfBand(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	live := cluster(deployment("shop", "web", 1))
	svc := start(t, index, connector(live), &pings{})

	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the object Current")

	if err := live.Tracker().Delete(deploymentGVR, "shop", "web"); err != nil {
		t.Fatalf("deleting from the fake cluster: %v", err)
	}

	settle(t, snapshotOf(svc), healthy(HealthNotFound), "the deleted object NotFound")
}

// #12's acceptance criterion: the panel follows a rollout rather than showing
// the state at the moment it was opened.
func TestWatchFollowsAnObjectAsItsHealthChanges(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	live := cluster(deployment("shop", "web", 0))
	svc := start(t, index, connector(live), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthInProgress), "the rollout InProgress")
	if got.Objects[0].Message == "" {
		t.Error("an InProgress object carries no message; kstatus supplies one")
	}

	if err := live.Tracker().Update(deploymentGVR, deployment("shop", "web", 1), "shop"); err != nil {
		t.Fatalf("updating the fake cluster: %v", err)
	}

	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the finished rollout Current")
}

// An object nobody declared is not part of the question the panel answers.
func TestWatchIgnoresObjectsTheRepositoryDoesNotDeclare(t *testing.T) {
	index := &declared{objects: []Object{
		object("apps/v1", "Deployment", "", "web"),
		object("apps/v1", "Deployment", "", "worker"),
	}}
	live := cluster(deployment("shop", "web", 1), deployment("shop", "worker", 1), deployment("shop", "stray", 1))
	svc := start(t, index, connector(live), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthCurrent), "both declared objects Current")

	if len(got.Objects) != 2 {
		t.Fatalf("objects = %d, want 2 — only what the repository declares", len(got.Objects))
	}
	for _, o := range got.Objects {
		if o.Name == "stray" {
			t.Error("an undeclared object reached the panel")
		}
	}
}

// The same object declared in two files gets two rows, and both are answered.
// A plan keyed by name alone would leave the first row NotFound forever.
func TestWatchAnswersAnObjectDeclaredInTwoFiles(t *testing.T) {
	index := &declared{objects: []Object{
		{APIVersion: "apps/v1", Kind: "Deployment", Name: "web", File: "base.yaml"},
		{APIVersion: "apps/v1", Kind: "Deployment", Name: "web", File: "overlay.yaml"},
	}}
	svc := start(t, index, connector(cluster(deployment("shop", "web", 1))), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthCurrent), "both rows Current")

	if len(got.Objects) != 2 {
		t.Fatalf("objects = %d, want a row per declaration", len(got.Objects))
	}
	if got.Objects[0].File == got.Objects[1].File {
		t.Error("both rows name the same file")
	}
}

// A CRD that is not installed is the ordinary reason a kind will not map. The
// row stays and says why; dropping it would show a project declaring fewer
// objects than it does.
func TestWatchMarksAnUnservedKindUnknown(t *testing.T) {
	index := &declared{objects: []Object{
		object("acme.io/v1", "Widget", "", "thing"),
		object("v1", "Service", "", "web"),
	}}
	svc := start(t, index, connector(cluster(service("web"))), &pings{})

	got := settle(t, snapshotOf(svc), func(s Snapshot) bool {
		return len(s.Objects) == 2 && s.Objects[1].Health == HealthCurrent
	}, "the served kind Current")

	widget := got.Objects[0]
	if widget.Health != HealthUnknown {
		t.Errorf("Widget health = %q, want %q", widget.Health, HealthUnknown)
	}
	if !strings.Contains(widget.Message, "acme.io/v1") || !strings.Contains(widget.Message, "Widget") {
		t.Errorf("Widget message = %q, want it to name the apiVersion and kind", widget.Message)
	}
}

// A namespace-scoped developer is an ordinary user. The group they may not read
// reports the API server's own sentence, and the session keeps watching the
// rest — the panel does not go dark because one namespace is off limits.
func TestWatchMarksAForbiddenGroupUnknownAndKeepsWatchingTheRest(t *testing.T) {
	index := &declared{objects: []Object{
		object("apps/v1", "Deployment", "", "web"),
		object("v1", "Service", "", "web"),
	}}
	live := cluster(deployment("shop", "web", 1), service("web"))
	live.PrependReactor("list", "deployments",
		func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewForbidden(
				deploymentGVR.GroupResource(), "web",
				errors.New(`User "dev" cannot list resource "deployments"`))
		})

	svc := start(t, index, connector(live), &pings{})

	got := settle(t, snapshotOf(svc), func(s Snapshot) bool {
		return len(s.Objects) == 2 && s.Objects[1].Health == HealthCurrent
	}, "the readable group Current")

	if got.Phase != PhaseWatching {
		t.Errorf("phase = %q, want %q: one forbidden group is not a broken connection",
			got.Phase, PhaseWatching)
	}
	if got.Objects[0].Health != HealthUnknown {
		t.Errorf("Deployment health = %q, want %q", got.Objects[0].Health, HealthUnknown)
	}
	if !strings.Contains(got.Objects[0].Message, "cannot list") {
		t.Errorf("message = %q, want the API server's own sentence", got.Objects[0].Message)
	}
}

// A namespace that does not exist yet is the state a repository sits in before
// its first apply, and reads the same way as a forbidden one: no verdict, with
// the reason.
func TestWatchMarksAMissingNamespaceUnknown(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	live := cluster()
	live.PrependReactor("list", "deployments",
		func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, "shop")
		})

	svc := start(t, index, connector(live), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthUnknown), "the object Unknown")
	if got.Phase != PhaseWatching {
		t.Errorf("phase = %q, want %q", got.Phase, PhaseWatching)
	}
}

// An incomplete binding starts nothing at all. "Whatever the kubeconfig would
// have picked" is the accident DESIGN.md §4 exists to prevent, read-only or not.
func TestWatchIsIdleWithoutABinding(t *testing.T) {
	tests := []struct {
		name      string
		target    string
		namespace string
	}{
		{name: "no context", target: "", namespace: "shop"},
		{name: "no namespace", target: "prod", namespace: ""},
		{name: "neither", target: "", namespace: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
			connect, tally := counting(func(string) (dynamic.Interface, meta.RESTMapper, error) {
				return nil, nil, errors.New("must not be reached")
			})
			svc := New(index, connect, &pings{})
			t.Cleanup(svc.Shutdown)

			got := svc.Watch("/repo", tt.target, tt.namespace)
			if got.Phase != PhaseIdle {
				t.Errorf("phase = %q, want %q", got.Phase, PhaseIdle)
			}
			if !strings.Contains(got.Reason, "no kube context and namespace are bound") {
				t.Errorf("reason = %q, want it to name the missing binding", got.Reason)
			}

			// Long enough for a session that was wrongly started to have tried.
			time.Sleep(20 * time.Millisecond)
			if tally.get() != 0 {
				t.Errorf("connected %d times to an unbound project, want 0", tally.get())
			}
		})
	}
}

func TestWatchIsIdleWhenNothingIsDeclaredAgainstTheBinding(t *testing.T) {
	svc := start(t, &declared{}, connector(cluster()), &pings{})

	settle(t, snapshotOf(svc), func(s Snapshot) bool {
		return s.Phase == PhaseIdle && strings.Contains(s.Reason, "nothing here is declared")
	}, "an idle session saying nothing is aimed at this binding")
}

// #12's acceptance criterion: a connection lost mid-watch reports reconnecting
// and then recovers, rather than crashing or freezing.
func TestWatchReconnectsAfterAFailureAndRecovers(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	live := cluster(deployment("shop", "web", 1))

	var mu sync.Mutex
	fail := true
	connect := func(string) (dynamic.Interface, meta.RESTMapper, error) {
		mu.Lock()
		defer mu.Unlock()
		if fail {
			return nil, nil, errors.New("dial tcp 10.0.0.1:443: connect: network is unreachable")
		}
		return live, mapper(), nil
	}

	svc := New(index, connect, &pings{})
	t.Cleanup(svc.Shutdown)
	svc.Watch("/repo", "prod", "shop")

	got := settle(t, snapshotOf(svc), func(s Snapshot) bool { return s.Phase == PhaseReconnecting },
		"a reconnecting session")
	if !strings.Contains(got.Reason, "network is unreachable") {
		t.Errorf("reason = %q, want the transport's own message", got.Reason)
	}

	mu.Lock()
	fail = false
	mu.Unlock()

	settle(t, snapshotOf(svc), healthy(HealthCurrent), "a recovered session")
}

// A refusal is its own phase: it sends the user to their login rather than to
// their network.
func TestWatchReportsARefusalAsUnauthorized(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{name: "401", err: apierrors.NewUnauthorized("token expired")},
		{
			name: "403",
			err: apierrors.NewForbidden(
				schema.GroupResource{Resource: "deployments"}, "web", errors.New("denied")),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
			svc := New(index, func(string) (dynamic.Interface, meta.RESTMapper, error) {
				return nil, nil, tt.err
			}, &pings{})
			t.Cleanup(svc.Shutdown)
			svc.Watch("/repo", "prod", "shop")

			got := settle(t, snapshotOf(svc),
				func(s Snapshot) bool { return s.Phase == PhaseUnauthorized },
				"an unauthorized session")
			if got.Reason == "" {
				t.Error("an unauthorized session gives no reason")
			}
		})
	}
}

// A binding is part of a session's identity, so two bindings on one checkout
// are two sessions watched at once. That is the repository laid out one
// directory per cluster (DESIGN.md §4), and the property that matters is that
// neither session's verdicts appear under the other's name.
func TestWatchKeepsOneSessionPerBinding(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	prod := cluster(deployment("shop", "web", 1))
	staging := cluster()

	connect := func(name string) (dynamic.Interface, meta.RESTMapper, error) {
		if name == "prod" {
			return prod, mapper(), nil
		}
		return staging, mapper(), nil
	}

	svc := New(index, connect, &pings{})
	t.Cleanup(svc.Shutdown)

	settle(t, func() Snapshot { return svc.Watch("/repo", "prod", "shop") },
		healthy(HealthCurrent), "the object Current in prod")
	settle(t, func() Snapshot { return svc.Watch("/repo", "staging", "shop") },
		healthy(HealthNotFound), "the object NotFound in staging")

	// And the first session is still answering for its own cluster.
	if got := svc.Watch("/repo", "prod", "shop"); got.Objects[0].Health != HealthCurrent {
		t.Errorf("prod health = %q after watching staging, want %q",
			got.Objects[0].Health, HealthCurrent)
	}
}

// A save that changes what a manifest says but not what it declares must not
// cost a reconnection. The panel would flicker through connecting on every
// keystroke-save otherwise.
func TestRefreshDoesNotRebuildWhenTheDeclaredObjectsAreUnchanged(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	connect, tally := counting(connector(cluster(deployment("shop", "web", 1))))
	svc := New(index, connect, &pings{})
	t.Cleanup(svc.Shutdown)

	svc.Watch("/repo", "prod", "shop")
	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the object Current")

	before := tally.get()
	for range 5 {
		svc.Refresh("/repo")
	}
	// Long enough for the session to do the wrong thing, if it is going to.
	time.Sleep(50 * time.Millisecond)

	if got := tally.get(); got != before {
		t.Errorf("connected %d more times for refreshes that changed nothing", got-before)
	}
	if got := svc.Watch("/repo", "prod", "shop"); got.Phase != PhaseWatching {
		t.Errorf("phase = %q, want %q throughout", got.Phase, PhaseWatching)
	}
}

// A save that adds a manifest does rebuild, and the new object appears.
func TestRefreshPicksUpANewlyDeclaredObject(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	svc := start(t, index, connector(cluster(deployment("shop", "web", 1), service("api"))), &pings{})

	settle(t, snapshotOf(svc), func(s Snapshot) bool { return len(s.Objects) == 1 }, "one object")

	index.set([]Object{
		object("apps/v1", "Deployment", "", "web"),
		object("v1", "Service", "", "api"),
	}, nil)
	svc.Refresh("/repo")

	settle(t, snapshotOf(svc), func(s Snapshot) bool {
		return len(s.Objects) == 2 && healthy(HealthCurrent)(s)
	}, "both objects Current")
}

// Refreshing a project nobody is watching must not start one: the file-change
// path calls this for every project, not only the ones with a panel open.
func TestRefreshIsANoOpForAProjectNotUnderWatch(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	connect, tally := counting(connector(cluster()))
	svc := New(index, connect, &pings{})
	t.Cleanup(svc.Shutdown)

	svc.Refresh("/never-opened")
	time.Sleep(20 * time.Millisecond)

	if got := tally.get(); got != 0 {
		t.Errorf("connected %d times for a project nobody watches", got)
	}
}

// Notices reach the panel beside the objects: a panel listing four objects out
// of a file declaring five has to say so.
func TestWatchCarriesTheIndexerNotices(t *testing.T) {
	index := &declared{
		objects: []Object{object("apps/v1", "Deployment", "", "web")},
		notices: []Notice{{File: "broken.yaml", Reason: "yaml: line 4: found a tab"}},
	}
	svc := start(t, index, connector(cluster(deployment("shop", "web", 1))), &pings{})

	got := settle(t, snapshotOf(svc), func(s Snapshot) bool { return len(s.Notices) == 1 },
		"the notice carried through")

	if got.Notices[0].File != "broken.yaml" {
		t.Errorf("notice = %+v, want the indexer's own", got.Notices[0])
	}
}

// A checkout that cannot be scanned is a failure of the connection cycle, not a
// silently empty panel.
func TestWatchReportsAnUnreadableCheckout(t *testing.T) {
	index := &declared{err: errors.New("indexing /repo: permission denied")}
	svc := start(t, index, connector(cluster()), &pings{})

	got := settle(t, snapshotOf(svc), func(s Snapshot) bool { return s.Phase == PhaseReconnecting },
		"a session reporting the scan failure")

	if !strings.Contains(got.Reason, "permission denied") {
		t.Errorf("reason = %q, want the scan's own message", got.Reason)
	}
}

// The panel is told to look again. Without this the state would be correct and
// invisible until something else happened to re-render.
func TestWatchAnnouncesChanges(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	seen := &pings{}
	svc := start(t, index, connector(cluster(deployment("shop", "web", 1))), seen)

	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the object Current")

	if seen.count() == 0 {
		t.Error("the session never announced a change")
	}
}

// The snapshot a caller holds must not change under it when the session moves
// on: the panel renders from it after the call returns.
func TestSnapshotIsACopy(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	live := cluster(deployment("shop", "web", 0))
	svc := start(t, index, connector(live), &pings{})

	got := settle(t, snapshotOf(svc), healthy(HealthInProgress), "the rollout InProgress")

	if err := live.Tracker().Update(deploymentGVR, deployment("shop", "web", 1), "shop"); err != nil {
		t.Fatalf("updating the fake cluster: %v", err)
	}
	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the finished rollout")

	if got.Objects[0].Health != HealthInProgress {
		t.Errorf("the held snapshot changed to %q under its holder", got.Objects[0].Health)
	}
}

func TestStopEndsASessionAndWatchStartsAFreshOne(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	connect, tally := counting(connector(cluster(deployment("shop", "web", 1))))
	svc := New(index, connect, &pings{})
	t.Cleanup(svc.Shutdown)

	svc.Watch("/repo", "prod", "shop")
	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the object Current")

	svc.Stop("/repo")
	svc.Stop("/repo") // idempotent
	after := tally.get()

	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the object Current again")

	if tally.get() <= after {
		t.Error("Watch after Stop reused the stopped session rather than starting one")
	}
}

// Shutdown must wait, not signal: a watch goroutine outliving the decision to
// exit is a connection the API server holds open until it times out.
func TestShutdownEndsEverySession(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	connect, tally := counting(connector(cluster(deployment("shop", "web", 1))))
	svc := New(index, connect, &pings{})

	svc.Watch("/one", "prod", "shop")
	svc.Watch("/two", "prod", "shop")
	settle(t, func() Snapshot { return svc.Watch("/one", "prod", "shop") },
		healthy(HealthCurrent), "the first session watching")
	settle(t, func() Snapshot { return svc.Watch("/two", "prod", "shop") },
		healthy(HealthCurrent), "the second session watching")

	svc.Shutdown()
	svc.Shutdown() // idempotent

	// Shutdown waits for its sessions, so nothing of the old ones is left to
	// connect once it returns.
	after := tally.get()

	settle(t, func() Snapshot { return svc.Watch("/one", "prod", "shop") },
		healthy(HealthCurrent), "a fresh session after shutdown")

	if tally.get() <= after {
		t.Error("Watch after Shutdown reused a stopped session rather than starting one")
	}
}

// Every snapshot crosses the Wails bridge, where a nil slice marshals to `null`
// and the panel that receives it iterates. An unbound project is the state every
// project starts in, so this is the crash the panel would take on first open.
func TestEverySnapshotCarriesListsRatherThanNulls(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	svc := New(index, connector(cluster(deployment("shop", "web", 1))), &pings{})
	t.Cleanup(svc.Shutdown)

	// Unbound, before any session exists.
	assertNoNulls(t, "unbound", svc.Watch("/repo", "", ""))

	// A live session, before its first observation and after it.
	assertNoNulls(t, "first call", svc.Watch("/repo", "prod", "shop"))
	assertNoNulls(t, "watching", settle(t, snapshotOf(svc), healthy(HealthCurrent), "the object Current"))
}

func assertNoNulls(t *testing.T, when string, got Snapshot) {
	t.Helper()

	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshaling the %s snapshot: %v", when, err)
	}
	for _, field := range []string{`"objects":null`, `"notices":null`} {
		if strings.Contains(string(raw), field) {
			t.Errorf("the %s snapshot serializes %s; the panel iterates it: %s", when, field, raw)
		}
	}
}

// A server that hangs up on every watch without delivering anything must not
// become a loop that reopens as fast as the network allows.
func TestAWatchThatClosesImmediatelyIsNotReopenedInATightLoop(t *testing.T) {
	index := &declared{objects: []Object{object("apps/v1", "Deployment", "", "web")}}
	live := cluster(deployment("shop", "web", 1))

	var mu sync.Mutex
	opened := 0
	live.PrependWatchReactor("deployments", func(k8stesting.Action) (bool, watch.Interface, error) {
		mu.Lock()
		opened++
		mu.Unlock()
		// Closed before it delivers anything, which is what a proxy that does
		// not understand watch does.
		hangup := watch.NewFake()
		hangup.Stop()
		return true, hangup, nil
	})

	svc := New(index, connector(live), &pings{})
	t.Cleanup(svc.Shutdown)
	svc.Watch("/repo", "prod", "shop")

	// The list still lands, so the panel is correct; only the watch is broken.
	settle(t, snapshotOf(svc), healthy(HealthCurrent), "the listed object Current")

	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	// At one attempt per minBackoff (1s), a 200ms window allows the first plus
	// at most one more. Without the pause this would be thousands.
	if opened > 2 {
		t.Errorf("reopened the watch %d times in 200ms; want it paced by the backoff", opened)
	}
}

// A group covering one object is narrowed at the API rather than listing the
// resource and filtering: the difference between reading one Secret and reading
// every Secret in the namespace.
func TestASingleObjectGroupIsNarrowedWithAFieldSelector(t *testing.T) {
	tests := []struct {
		name  string
		names map[string][]int
		want  string
	}{
		{name: "one object", names: map[string][]int{"web": {0}}, want: "metadata.name=web"},
		{name: "two objects", names: map[string][]int{"web": {0}, "api": {1}}, want: ""},
		{name: "none", names: map[string][]int{}, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := group{names: tt.names}.options()
			if got.FieldSelector != tt.want {
				t.Errorf("FieldSelector = %q, want %q", got.FieldSelector, tt.want)
			}
		})
	}
}

// describe names what a group covers, for the message about a group that could
// not be read.
func TestGroupDescribeNamesTheResourceAndNamespace(t *testing.T) {
	namespaced := group{key: groupKey{resource: deploymentGVR, namespace: "shop"}}
	if got, want := namespaced.describe(), "deployments in shop"; got != want {
		t.Errorf("describe() = %q, want %q", got, want)
	}

	clusterWide := group{key: groupKey{resource: namespaceGVR}}
	if got, want := clusterWide.describe(), "namespaces"; got != want {
		t.Errorf("describe() = %q, want %q", got, want)
	}
}

func TestBackoffDoublesToACap(t *testing.T) {
	got := next(0)
	if got != minBackoff {
		t.Errorf("next(0) = %v, want %v", got, minBackoff)
	}
	for range 10 {
		previous := got
		got = next(got)
		if got < previous {
			t.Fatalf("next(%v) = %v, want it not to shrink", previous, got)
		}
	}
	if got != maxBackoff {
		t.Errorf("the backoff settled at %v, want the cap %v", got, maxBackoff)
	}
}

// A watch error event has to become an error the cycle can act on, and one
// carrying a Status has to keep its typed reason: that is how a 410 Gone stays
// distinguishable from a 401 after crossing the watch channel.
func TestAWatchErrorEventBecomesAnError(t *testing.T) {
	expired := fromEvent(watch.Event{
		Type: watch.Error,
		Object: &metav1.Status{
			Message: "too old resource version", Reason: metav1.StatusReasonExpired, Code: 410,
		},
	})
	if !apierrors.IsResourceExpired(expired) {
		t.Errorf("fromEvent lost the typed reason; got %v", expired)
	}

	// A server that sent something else still has to end the watch.
	opaque := fromEvent(watch.Event{Type: watch.Error, Object: &unstructured.Unstructured{}})
	if opaque == nil {
		t.Error("fromEvent returned no error for an undescribed error event")
	}
}

// apiMessage prefers the API server's own sentence and falls back to the error.
func TestAPIMessagePrefersTheServersSentence(t *testing.T) {
	forbidden := apierrors.NewForbidden(
		deploymentGVR.GroupResource(), "web", errors.New(`User "dev" cannot list`))
	if got := apiMessage(forbidden); !strings.Contains(got, "cannot list") {
		t.Errorf("apiMessage = %q, want the server's sentence", got)
	}

	plain := errors.New("something else entirely")
	if got := apiMessage(plain); got != plain.Error() {
		t.Errorf("apiMessage = %q, want %q", got, plain.Error())
	}
}
