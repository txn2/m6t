package kubeexec

import (
	"bytes"
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// recorder is the exec seam standing in for a real kubectl. It records every
// argv it is handed, which is what lets a test assert not only what was built
// but that nothing was built at all.
type recorder struct {
	calls  [][]string
	result Result
	err    error
}

func (r *recorder) run(_ context.Context, argv []string) (Result, error) {
	r.calls = append(r.calls, argv)
	if r.err != nil {
		return Result{}, r.err
	}
	result := r.result
	result.Argv = argv
	return result, nil
}

func serviceWith(rec *recorder) *Service {
	return &Service{run: rec.run}
}

func bound() Binding {
	return Binding{Context: "prod-us-west", Namespace: "platform"}
}

// The invariant this package exists for: the target is stated on the argv, in
// full, every time.
func TestCheckStatesContextAndNamespaceExplicitly(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	if _, err := serviceWith(rec).Check(context.Background(), bound()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	if len(rec.calls) != 1 {
		t.Fatalf("kubectl was invoked %d times, want 1", len(rec.calls))
	}
	want := []string{"kubectl", "--context=prod-us-west", "--namespace=platform", "version", "-o", "json"}
	if !reflect.DeepEqual(rec.calls[0], want) {
		t.Errorf("argv = %v, want %v", rec.calls[0], want)
	}
}

// The acceptance criterion from #10: with no binding, no kubectl process is
// ever spawned. Asserted twice over — the exec seam recorded nothing, and the
// argv log this package writes on every invocation stayed empty.
func TestAnIncompleteBindingSpawnsNothing(t *testing.T) {
	tests := []struct {
		name    string
		binding Binding
	}{
		{name: "unbound", binding: Binding{}},
		{name: "context only", binding: Binding{Context: "prod-us-west"}},
		{name: "namespace only", binding: Binding{Namespace: "platform"}},
		{name: "whitespace is not a binding", binding: Binding{Context: "  ", Namespace: "\t"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Not parallel: the log destination is process-wide state.
			var logged bytes.Buffer
			restore := captureLog(t, &logged)
			defer restore()

			rec := &recorder{}
			_, err := serviceWith(rec).Check(context.Background(), test.binding)

			if !errors.Is(err, ErrUnbound) {
				t.Fatalf("Check with %+v error = %v, want ErrUnbound", test.binding, err)
			}
			if len(rec.calls) != 0 {
				t.Errorf("kubectl was invoked with %v, want no invocation at all", rec.calls)
			}
			if logged.Len() != 0 {
				t.Errorf("an invocation was logged (%q), want none", logged.String())
			}
		})
	}
}

// A kubectl that ran and failed is a Result the user can read, not an error.
// Collapsing the two would hide the stderr that says which namespace does not
// exist behind a generic failure box.
func TestANonZeroExitIsAResultNotAnError(t *testing.T) {
	// Not parallel: t.Setenv rewrites process-wide PATH.
	dir := t.TempDir()
	stub := fakeKubectl(t, dir, `>&2 echo "Error from server (Forbidden): unknown"; exit 43`)
	t.Setenv("PATH", filepath.Dir(stub))

	result, err := New().Check(context.Background(), bound())
	if err != nil {
		t.Fatalf("Check on a failing kubectl returned an error: %v", err)
	}
	if result.ExitCode != 43 {
		t.Errorf("exit code = %d, want 43", result.ExitCode)
	}
	if !strings.Contains(result.Stderr, "Forbidden") {
		t.Errorf("stderr = %q, want kubectl's own message verbatim", result.Stderr)
	}
}

// The real runner, end to end: argv reaches the binary, stdout comes back, and
// the Result names the command the user could have typed themselves.
func TestRunCapturesOutputAndArgv(t *testing.T) {
	// Not parallel: t.Setenv rewrites process-wide PATH.
	dir := t.TempDir()
	stub := fakeKubectl(t, dir, `echo "$@"`)
	t.Setenv("PATH", filepath.Dir(stub))

	result, err := New().Check(context.Background(), bound())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", result.ExitCode)
	}

	got := strings.TrimSpace(result.Stdout)
	want := "--context=prod-us-west --namespace=platform version -o json"
	if got != want {
		t.Errorf("kubectl received %q, want %q", got, want)
	}
	if result.Argv[0] != "kubectl" {
		t.Errorf("Argv = %v, want the binary's own name first", result.Argv)
	}
}

func TestAMissingKubectlIsReported(t *testing.T) {
	// Not parallel: t.Setenv rewrites process-wide PATH.
	t.Setenv("PATH", t.TempDir())

	if _, err := New().Check(context.Background(), bound()); !errors.Is(err, ErrNoKubectl) {
		t.Errorf("Check with no kubectl on PATH error = %v, want ErrNoKubectl", err)
	}
}

// A context and namespace beginning with a dash must reach kubectl as values,
// not as flags of their own — which is what the `--flag=value` form guarantees.
func TestLeadingDashesStayValues(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	binding := Binding{Context: "--not-a-flag", Namespace: "-also-not"}
	if _, err := serviceWith(rec).Check(context.Background(), binding); err != nil {
		t.Fatalf("Check: %v", err)
	}

	argv := rec.calls[0]
	if argv[1] != "--context=--not-a-flag" || argv[2] != "--namespace=-also-not" {
		t.Errorf("argv = %v, want both values carried inside their own flag", argv)
	}
}

func TestCancellationIsReportedAsAnError(t *testing.T) {
	// Not parallel: t.Setenv rewrites process-wide PATH.
	dir := t.TempDir()
	stub := fakeKubectl(t, dir, `sleep 30`)
	t.Setenv("PATH", filepath.Dir(stub))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := New().Check(ctx, bound()); err == nil {
		t.Error("Check with a canceled context returned no error, want one")
	}
}

// A failure to start the binary at all — found on PATH, not executable as a
// program — is an error rather than a Result, because no verdict was produced.
func TestAnUnrunnableKubectlIsAnError(t *testing.T) {
	// Not parallel: t.Setenv rewrites process-wide PATH.
	dir := t.TempDir()
	path := filepath.Join(dir, "kubectl")
	// Executable, but not a program: no shebang and not a valid binary.
	if err := os.WriteFile(path, []byte("\x00\x01not a program"), 0o700); err != nil {
		t.Fatalf("writing the stub: %v", err)
	}
	t.Setenv("PATH", dir)

	_, err := New().Check(context.Background(), bound())
	if err == nil {
		t.Fatal("Check with an unrunnable kubectl returned no error, want one")
	}
	if errors.Is(err, ErrNoKubectl) || errors.Is(err, ErrUnbound) {
		t.Errorf("error = %v, want a failure to run rather than a sentinel", err)
	}
}

func TestTheArgvIsLogged(t *testing.T) {
	var logged bytes.Buffer
	restore := captureLog(t, &logged)
	defer restore()

	dir := t.TempDir()
	stub := fakeKubectl(t, dir, `echo ok`)
	t.Setenv("PATH", filepath.Dir(stub))

	if _, err := New().Check(context.Background(), bound()); err != nil {
		t.Fatalf("Check: %v", err)
	}

	if !strings.Contains(logged.String(), "--context=prod-us-west --namespace=platform version") {
		t.Errorf("log = %q, want the argv m6t ran against the user's cluster", logged.String())
	}
}

// captureLog redirects the standard logger into buf for one test.
func captureLog(t *testing.T, buf *bytes.Buffer) func() {
	t.Helper()

	output := log.Writer()
	flags := log.Flags()
	log.SetOutput(buf)
	log.SetFlags(0)
	return func() {
		log.SetOutput(output)
		log.SetFlags(flags)
	}
}

// fakeKubectl writes a shell script named kubectl into dir and returns its
// path. The script is a test fixture standing in for the user's real binary —
// the package under test still execs it directly, with no shell of its own.
func fakeKubectl(t *testing.T, dir, body string) string {
	t.Helper()

	if _, err := exec.LookPath("sh"); err != nil {
		t.Skipf("no sh available to build a kubectl stub: %v", err)
	}

	path := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatalf("writing the kubectl stub: %v", err)
	}
	return path
}

// The cluster-scoped path: a context, and deliberately no namespace. A
// --namespace on a namespace listing would be theater kubectl ignores, and it
// would hide that the call is not scoped to one.
func TestNamespacesStatesTheContextAndNoNamespace(t *testing.T) {
	t.Parallel()

	rec := &recorder{result: Result{Stdout: "namespace/default\nnamespace/kube-system\n"}}
	got, err := serviceWith(rec).Namespaces(context.Background(), "prod-us-west")
	if err != nil {
		t.Fatalf("Namespaces: %v", err)
	}

	want := []string{"kubectl", "--context=prod-us-west", "get", "namespaces", "-o", "name"}
	if !reflect.DeepEqual(rec.calls[0], want) {
		t.Errorf("argv = %v, want %v", rec.calls[0], want)
	}
	if !reflect.DeepEqual(got, []string{"default", "kube-system"}) {
		t.Errorf("namespaces = %v, want the bare names", got)
	}
}

func TestNamespacesRefusesWithoutAContext(t *testing.T) {
	t.Parallel()

	rec := &recorder{}
	if _, err := serviceWith(rec).Namespaces(context.Background(), "  "); !errors.Is(err, ErrUnbound) {
		t.Fatalf("Namespaces with no context error = %v, want ErrUnbound", err)
	}
	if len(rec.calls) != 0 {
		t.Errorf("kubectl was invoked with %v, want no invocation at all", rec.calls)
	}
}

// Listing namespaces is a permission many users of a shared cluster do not
// have. It is an error the caller shrugs at rather than a Result, because there
// is no output for a user to read — only a list that did not arrive.
func TestNamespacesReportsARefusalAsAnError(t *testing.T) {
	t.Parallel()

	rec := &recorder{result: Result{ExitCode: 1, Stderr: `namespaces is forbidden`}}
	_, err := serviceWith(rec).Namespaces(context.Background(), "prod-us-west")
	if err == nil {
		t.Fatal("Namespaces on a forbidden listing returned no error, want one")
	}
	if !strings.Contains(err.Error(), "forbidden") {
		t.Errorf("error = %v, want kubectl's own reason", err)
	}
}

func TestNamespacesReportsAMissingKubectl(t *testing.T) {
	// Not parallel: t.Setenv rewrites process-wide PATH.
	t.Setenv("PATH", t.TempDir())

	if _, err := New().Namespaces(context.Background(), "prod"); !errors.Is(err, ErrNoKubectl) {
		t.Errorf("Namespaces with no kubectl error = %v, want ErrNoKubectl", err)
	}
}

func TestNamesIgnoresBlankLinesAndPrefixes(t *testing.T) {
	t.Parallel()

	got := names("namespace/default\n\n  namespace/kube-system  \nbare\n")
	want := []string{"default", "kube-system", "bare"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("names = %v, want %v", got, want)
	}
}
