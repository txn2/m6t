// Package kubeexec runs `kubectl` on behalf of a project, with the target
// cluster and namespace stated on every single invocation (DESIGN.md §3.2, §4).
//
// The one invariant this package exists to hold: no operation that acts inside
// a namespace reaches kubectl without both `--context` and `--namespace`. The
// kubeconfig's current-context is never used, never read and never fallen back
// to, because "whatever kubectl would have done" is how a manifest lands in the
// wrong cluster — and a namespace left off is the same failure one level down,
// since kubectl answers a missing `--namespace` with the context's own default.
// A binding missing either half is refused before a process exists
// (ErrUnbound), which is the state a project sits in until the user binds it.
//
// There is exactly one other shape, and it is deliberately a separate path
// rather than an exception to the one above: a cluster-scoped discovery call,
// which states its context and has no namespace to state. Namespaces lists the
// namespaces a context offers, and a `--namespace` on that request would be
// theater — kubectl ignores it — while also hiding the fact that the call is
// not scoped to one. Keeping the two builders apart is what stops "this one
// does not really need it" from becoming an argument anyone can make at a
// namespaced call site.
//
// kubectl is invoked with an argv slice and never through a shell (CLAUDE.md,
// .semgrep/go-security.yml), so a repository path holding shell metacharacters
// is inert. The argv is logged on every call — what the app ran against the
// user's cluster is the first thing anyone debugging it needs, and it is also
// what makes "no process was spawned" a testable claim rather than an assertion.
//
// A kubectl that runs and fails is not an error here. A nonexistent namespace,
// a denied RBAC rule and an expired credential are all things the user can read
// and act on, so they come back as a Result carrying the exit code and
// kubectl's own stderr verbatim (CLAUDE.md: tool errors are not translated into
// prose). An error from this package means the command never produced a verdict:
// kubectl is missing, the binding is incomplete, or the call timed out.
//
// It imports nothing first-party. Binding is declared here rather than taken
// from internal/project for the reason every service seam is (DESIGN.md §3.2):
// services are siblings, and internal/app is what maps a project's resolved
// binding onto this one.
package kubeexec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// binaryName is the executable this package drives. It is resolved through PATH
// on every call rather than cached at construction, for the reason internal/git
// gives: a user who installs kubectl while m6t is running should not have to
// restart it.
const binaryName = "kubectl"

// commandTimeout bounds one invocation.
//
// It is generous because an exec credential plugin (EKS, GKE, OIDC) can take
// seconds on a cold cache, and an interactive one can take longer still. What
// the deadline is actually for is the call with no other exit: an API server
// that accepted the connection and then stopped answering leaves kubectl
// waiting on a socket, and without a deadline the UI waits with it forever.
//
// It is one number for every call here, and #11's mutations are the first
// callers it is wrong for: `kubectl delete` waits on finalizers by default, so
// deleting a namespace outlives this and comes back as "timed out" — an error
// meaning no verdict was produced — while the deletion was in fact accepted and
// the objects are terminating. That is #65, and it is a decision about what a
// partially-observed mutation should say rather than a number to raise, which is
// why it is not raised here.
const commandTimeout = 60 * time.Second

// Errors this package returns instead of a Result. Each one means no verdict
// was produced, which is a different thing for the UI to say than "kubectl ran
// and said no".
var (
	// ErrUnbound reports a call made with no context or no namespace. It is
	// returned before any process is created.
	ErrUnbound = errors.New("no kube context and namespace are bound")

	// ErrNoKubectl reports that no kubectl executable was found on PATH.
	ErrNoKubectl = errors.New("kubectl was not found on PATH")
)

// Binding is where an invocation is aimed. Both fields are required; see
// ErrUnbound.
type Binding struct {
	// Context is the kubeconfig context name, passed as --context.
	Context string

	// Namespace is passed as --namespace on every call, including the ones
	// that ignore it. Deciding per subcommand whether the flag is meaningful
	// would make the invariant a judgement call at each call site, and the
	// invariant is the entire point of this package.
	Namespace string
}

// Result is what one kubectl invocation produced.
type Result struct {
	// Argv is the full argument vector, kubectl's own name included. It is
	// returned to the frontend so the cluster panel can show the user the
	// command they could have typed themselves (DESIGN.md §1).
	Argv []string `json:"argv"`

	// ExitCode is kubectl's status. Zero is success; anything else is a
	// failure the user reads out of Stderr.
	ExitCode int `json:"exitCode"`

	// Stdout and Stderr are captured verbatim, untranslated.
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

// Service runs kubectl for the app.
type Service struct {
	// run is the exec seam. Production is runKubectl; tests replace it to
	// assert what was built and, more importantly, to assert that nothing was
	// built at all when the binding was incomplete.
	run func(ctx context.Context, argv []string) (Result, error)
}

// New builds a service driving the kubectl on the user's PATH.
func New() *Service {
	return &Service{run: runKubectl}
}

// Check asks the bound cluster whether it is reachable and who it thinks the
// caller is: `kubectl version -o json`, which contacts the API server.
//
// `version` rather than `get --raw /readyz` because the two prove the same
// thing about the connection and only one of them is available to every user.
// Reading /readyz is a nonResourceURL that ordinary RBAC does not grant, so a
// developer with namespace-scoped access would see the smoke test fail against
// a cluster they can perfectly well deploy to. Version discovery is in
// system:discovery, which every authenticated user has — so a failure here is a
// real failure of the binding rather than of the user's permissions.
//
// It goes through the same argv builder as every other call, so the binding is
// enforced here too: this is the action the UI offers on an unbound project's
// panel, and it must refuse rather than fall back.
func (s *Service) Check(ctx context.Context, binding Binding) (Result, error) {
	return s.exec(ctx, binding, "version", "-o", "json")
}

// Namespaces lists the namespaces the given context offers, for the binding
// forms to complete a namespace field from rather than making the user retype
// what their cluster already knows.
//
// A user whose RBAC does not let them list namespaces is an ordinary user, not
// a broken one — namespace-scoped access is the common case in a shared
// cluster — so the caller is expected to treat a failure here as "no
// suggestions" and leave the field typeable. That is why this returns names
// rather than a Result: there is no output a user needs to read, only a list
// that either arrived or did not.
func (s *Service) Namespaces(ctx context.Context, target string) ([]string, error) {
	argv, err := clusterArgv(target, "get", "namespaces", "-o", "name")
	if err != nil {
		return nil, err
	}

	result, err := s.run(ctx, argv)
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("listing namespaces in %s: %s",
			target, strings.TrimSpace(result.Stderr))
	}
	return names(result.Stdout), nil
}

// names turns `-o name` output ("namespace/kube-system") into bare names.
func names(out string) []string {
	listed := make([]string, 0, strings.Count(out, "\n"))
	for line := range strings.SplitSeq(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		listed = append(listed, trimmed[strings.LastIndex(trimmed, "/")+1:])
	}
	return listed
}

// clusterArgv builds the argument vector for a cluster-scoped call: the
// context, and no namespace. See the package comment for why this is a
// separate builder rather than a flag on the namespaced one.
func clusterArgv(target string, args ...string) ([]string, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return nil, fmt.Errorf("running kubectl %s: %w", strings.Join(args, " "), ErrUnbound)
	}

	argv := make([]string, 0, len(args)+2)
	argv = append(argv, binaryName, "--context="+trimmed)
	return append(argv, args...), nil
}

// exec builds the argv for a namespaced subcommand and runs it.
//
// Every namespaced operation goes through here, which is what makes the
// context/namespace invariant a property of the package rather than a habit of
// its call sites.
func (s *Service) exec(ctx context.Context, binding Binding, args ...string) (Result, error) {
	argv, err := binding.argv(args)
	if err != nil {
		return Result{}, err
	}
	return s.run(ctx, argv)
}

// argv builds the full argument vector, or refuses.
//
// The flags are written as `--flag=value` rather than as two entries so a
// context or namespace beginning with a dash cannot be read as a flag of its
// own. They come before the subcommand because that is where kubectl's own
// documentation puts global options, and being conventional here costs nothing.
func (b Binding) argv(args []string) ([]string, error) {
	target := strings.TrimSpace(b.Context)
	namespace := strings.TrimSpace(b.Namespace)
	if target == "" || namespace == "" {
		return nil, fmt.Errorf("running kubectl %s: %w", strings.Join(args, " "), ErrUnbound)
	}

	argv := make([]string, 0, len(args)+3)
	argv = append(argv, binaryName, "--context="+target, "--namespace="+namespace)
	return append(argv, args...), nil
}

// runKubectl executes an argv and captures its result.
func runKubectl(ctx context.Context, argv []string) (Result, error) {
	binary, err := exec.LookPath(binaryName)
	if err != nil {
		return Result{}, ErrNoKubectl
	}

	log.Printf("m6t: running %s %s", binary, command(argv))

	deadline, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()

	cmd := exec.CommandContext(deadline, binary, argv[1:]...)
	cmd.Env = commandEnv()
	// An empty reader, never the inherited stdin: an exec credential plugin
	// that decided to prompt would otherwise read keystrokes meant for a shell
	// in another pane, and an empty stdin turns that prompt into a failure the
	// user can see instead of a hang they cannot.
	cmd.Stdin = strings.NewReader("")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	result := Result{Argv: argv, Stdout: stdout.String(), Stderr: stderr.String()}

	var exit *exec.ExitError
	switch {
	case err == nil:
		return result, nil
	case deadline.Err() != nil:
		return Result{}, fmt.Errorf("kubectl %s timed out after %s", command(argv), commandTimeout)
	case errors.As(err, &exit):
		// The verdict case: kubectl ran, decided against us, and said why on
		// stderr. That is a Result, not an error — see the package comment.
		result.ExitCode = exit.ExitCode()
		return result, nil
	default:
		return Result{}, fmt.Errorf("running kubectl %s: %w", command(argv), err)
	}
}

// command renders an argv as the line a user could have typed, for a log entry
// or an error message. It drops argv[0] because every caller already says
// "kubectl" in its own sentence.
func command(argv []string) string {
	return strings.Join(argv[1:], " ")
}

// commandEnv is the user's environment with the locale pinned.
//
// The environment is inherited whole because that is where the user's
// credentials live: KUBECONFIG, AWS_PROFILE, CLOUDSDK_*, and whatever an exec
// auth plugin reads. m6t is a workbench over the user's own credentials and
// never a store of them (DESIGN.md §1), which means passing the environment
// through rather than reconstructing it.
func commandEnv() []string {
	return append(os.Environ(), "LC_ALL=C")
}
