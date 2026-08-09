package stream

import (
	"io/fs"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The registration gate. A test that dials /events and then causes an event to
// be published must wait for the subscription first.
//
// This is a rule about tests, enforced on tests, because the failure it
// prevents is not a bug in the server. publish is correct: it sends to the
// subscribers the registry holds. What is wrong is asking it to deliver to a
// connection the server has not been told about yet — gorilla writes the 101
// inside Upgrade, so dial returns before the handler reaches register, and the
// event is skipped in silence and never repeated.
//
// The cost of leaving it to memory is what #71 was: `make verify` green, the
// Test job red on a diff that cannot reach this package, and passing on re-run.
// Either reading of that failure is expensive — a contributor who believes it
// goes hunting in code they did not touch, and one who learns to press re-run
// stops reading Test failures at all.
//
// So the wait is checked rather than remembered, the same way the Makefile's
// git-diff gates are (TestGitDiffGatesRequireTrackedFiles).

// testFuncRe splits a gofmt'd test file into functions and their bodies. The
// closing brace of a top-level function is the only one in column zero, which
// is what `\n\}` says: a brace immediately after a line break and nothing
// before it.
var testFuncRe = regexp.MustCompile(`(?ms)^func (Test\w+)\(t \*testing\.T\) \{\n(.*?)\n\}`)

// eventsDialRe matches a subscription to the event channel.
var eventsDialRe = regexp.MustCompile(`dial\w*\(t, endpoint, "/events"\)`)

// publishRe matches the two ways a test causes an event to be published: the
// exported Publish methods, and ending a session, which makes the forwarder
// publish the exit.
var publishRe = regexp.MustCompile(`\.Publish\w+\(|\.exit\(`)

// awaitRe matches the wait that closes the window between the two.
var awaitRe = regexp.MustCompile(`awaitSubscribers\(`)

// TestEventTestsWaitForTheirSubscriptions fails when a test in this package
// subscribes to /events and publishes without waiting for the subscription to
// be registered.
func TestEventTestsWaitForTheirSubscriptions(t *testing.T) {
	unguarded := scanForUnguardedPublishes(t, readPackageTests(t))
	if len(unguarded) == 0 {
		return
	}

	t.Errorf("these tests dial /events and then publish without waiting for the "+
		"subscription to be registered, so whether they receive the event is "+
		"decided by goroutine scheduling (#71). Add awaitSubscribers(t, server, n) "+
		"after the dials:\n  %s", strings.Join(unguarded, "\n  "))
}

// TestRegistrationGateDetectorFires pins the scan above. A detector that
// matched nothing would report every test as guarded while looking green,
// which is the same silent pass the gate exists to prevent.
func TestRegistrationGateDetectorFires(t *testing.T) {
	guarded := "func TestGuarded(t *testing.T) {\n" +
		"\tfirst := dial(t, endpoint, \"/events\")\n" +
		"\tawaitSubscribers(t, server, 1)\n" +
		"\tserver.PublishGit(\"/repo\")\n" +
		"}\n"
	unguarded := "func TestUnguarded(t *testing.T) {\n" +
		"\tfirst := dial(t, endpoint, \"/events\")\n" +
		"\tserver.PublishGit(\"/repo\")\n" +
		"}\n"
	viaExit := "func TestViaExit(t *testing.T) {\n" +
		"\tfirst := dial(t, endpoint, \"/events\")\n" +
		"\tterminals.session().exit(3)\n" +
		"}\n"
	// A test that never subscribes cannot lose an event it was not sent.
	unrelated := "func TestUnrelated(t *testing.T) {\n" +
		"\tc := dial(t, endpoint, \"/pty/\"+fakeSessionID)\n" +
		"\tterminals.session().exit(0)\n" +
		"}\n"

	for _, tt := range []struct {
		name string
		src  string
		want []string
	}{
		{name: "guarded", src: guarded, want: nil},
		{name: "unguarded", src: unguarded, want: []string{"x_test.go:TestUnguarded"}},
		{name: "publishes by ending a session", src: viaExit, want: []string{"x_test.go:TestViaExit"}},
		{name: "never subscribes", src: unrelated, want: nil},
		{
			name: "one of each",
			src:  guarded + "\n" + unguarded + "\n" + unrelated,
			want: []string{"x_test.go:TestUnguarded"},
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := scanForUnguardedPublishes(t, map[string]string{"x_test.go": tt.src})
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Errorf("scan = %v, want %v", got, tt.want)
			}
		})
	}
}

// scanForUnguardedPublishes names every test function that subscribes and
// publishes without waiting in between, as "file.go:TestName".
func scanForUnguardedPublishes(t *testing.T, sources map[string]string) []string {
	t.Helper()

	var unguarded []string
	for file, src := range sources {
		for _, m := range testFuncRe.FindAllStringSubmatch(src, -1) {
			name, body := m[1], m[2]
			if !eventsDialRe.MatchString(body) || !publishRe.MatchString(body) {
				continue
			}
			if !awaitRe.MatchString(body) {
				unguarded = append(unguarded, file+":"+name)
			}
		}
	}
	sort.Strings(unguarded)
	return unguarded
}

// readPackageTests returns this package's test sources by name. Reading the
// files rather than the AST keeps the rule legible: what it matches is what a
// reviewer reads in the diff.
func readPackageTests(t *testing.T) map[string]string {
	t.Helper()

	// The working directory of a test binary is its own package directory.
	entries, err := fs.Glob(os.DirFS("."), "*_test.go")
	if err != nil {
		t.Fatalf("listing the package's test files: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("found no _test.go files in this package; the scan below would " +
			"report every test as guarded without having read one")
	}

	sources := make(map[string]string, len(entries))
	for _, name := range entries {
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		sources[name] = string(data)
	}
	return sources
}
