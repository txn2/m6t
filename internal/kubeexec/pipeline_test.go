package kubeexec

import (
	"bytes"
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// manifest is the resolved, absolute path internal/app hands these calls.
const manifest = "/repo/prod/api/deploy.yaml"

// Every pipeline subcommand, as the argv it must build. The table is the
// contract: a flag that moved, disappeared or arrived is a diff here, which is
// the only place in this repository that states what m6t runs against a
// cluster.
func TestPipelineArgv(t *testing.T) {
	t.Parallel()

	prefix := []string{"kubectl", "--context=prod-us-west", "--namespace=platform"}
	tests := []struct {
		name string
		call func(*Service) (Result, error)
		want []string
	}{
		{
			name: "validate is a server dry run of the apply",
			call: func(s *Service) (Result, error) {
				return s.Validate(context.Background(), bound(), manifest, false, false)
			},
			want: []string{"apply", "--dry-run=server", "--filename=" + manifest},
		},
		{
			name: "validate carries server-side apply",
			call: func(s *Service) (Result, error) {
				return s.Validate(context.Background(), bound(), manifest, false, true)
			},
			want: []string{"apply", "--server-side", "--dry-run=server", "--filename=" + manifest},
		},
		{
			name: "diff",
			call: func(s *Service) (Result, error) {
				return s.Diff(context.Background(), bound(), manifest, false, false)
			},
			want: []string{"diff", "--filename=" + manifest},
		},
		{
			name: "diff carries server-side apply",
			call: func(s *Service) (Result, error) {
				return s.Diff(context.Background(), bound(), manifest, false, true)
			},
			want: []string{"diff", "--server-side", "--filename=" + manifest},
		},
		{
			name: "apply",
			call: func(s *Service) (Result, error) {
				return s.Apply(context.Background(), bound(), manifest, false, false)
			},
			want: []string{"apply", "--filename=" + manifest},
		},
		{
			name: "apply a directory recurses",
			call: func(s *Service) (Result, error) {
				return s.Apply(context.Background(), bound(), "/repo/prod", true, false)
			},
			want: []string{"apply", "--filename=/repo/prod", "--recursive"},
		},
		{
			name: "delete preview is a server dry run of the delete",
			call: func(s *Service) (Result, error) {
				return s.DeletePreview(context.Background(), bound(), manifest, false)
			},
			want: []string{"delete", "--dry-run=server", "--filename=" + manifest},
		},
		{
			name: "delete",
			call: func(s *Service) (Result, error) {
				return s.Delete(context.Background(), bound(), manifest, false)
			},
			want: []string{"delete", "--filename=" + manifest},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			rec := &recorder{}
			if _, err := test.call(serviceWith(rec)); err != nil {
				t.Fatalf("call: %v", err)
			}
			if len(rec.calls) != 1 {
				t.Fatalf("kubectl was invoked %d times, want 1", len(rec.calls))
			}
			want := slices.Concat(prefix, test.want)
			if !reflect.DeepEqual(rec.calls[0], want) {
				t.Errorf("argv = %v, want %v", rec.calls[0], want)
			}
		})
	}
}

// The property the whole preview rests on: the thing dry-run reports is the
// thing apply does. Asserted as a relationship rather than as two literal argvs,
// so a flag added to one and forgotten on the other fails here even if both
// tables above were updated to match themselves.
func TestValidateIsApplyPlusTheDryRun(t *testing.T) {
	t.Parallel()

	for _, serverSide := range []bool{false, true} {
		validating := &recorder{}
		if _, err := serviceWith(validating).Validate(
			context.Background(), bound(), manifest, true, serverSide); err != nil {
			t.Fatalf("Validate: %v", err)
		}
		applying := &recorder{}
		if _, err := serviceWith(applying).Apply(
			context.Background(), bound(), manifest, true, serverSide); err != nil {
			t.Fatalf("Apply: %v", err)
		}

		stripped := without(validating.calls[0], "--dry-run=server")
		if !reflect.DeepEqual(stripped, applying.calls[0]) {
			t.Errorf("server-side=%v: validate without its dry run = %v, want the apply %v",
				serverSide, stripped, applying.calls[0])
		}
		if len(stripped) == len(validating.calls[0]) {
			t.Errorf("server-side=%v: validate argv %v carries no dry run at all",
				serverSide, validating.calls[0])
		}
	}
}

// The same property for the delete half.
func TestDeletePreviewIsDeletePlusTheDryRun(t *testing.T) {
	t.Parallel()

	previewing := &recorder{}
	if _, err := serviceWith(previewing).DeletePreview(
		context.Background(), bound(), manifest, false); err != nil {
		t.Fatalf("DeletePreview: %v", err)
	}
	deleting := &recorder{}
	if _, err := serviceWith(deleting).Delete(
		context.Background(), bound(), manifest, false); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	stripped := without(previewing.calls[0], "--dry-run=server")
	if !reflect.DeepEqual(stripped, deleting.calls[0]) {
		t.Errorf("preview without its dry run = %v, want the delete %v", stripped, deleting.calls[0])
	}
	if len(stripped) == len(previewing.calls[0]) {
		t.Errorf("preview argv %v carries no dry run at all", previewing.calls[0])
	}
}

// without returns argv with the first occurrence of flag removed.
func without(argv []string, flag string) []string {
	at := slices.Index(argv, flag)
	if at < 0 {
		return slices.Clone(argv)
	}
	return slices.Concat(argv[:at], argv[at+1:])
}

// The invariant, applied to the calls that mutate: an incomplete binding stops
// every one of them before a process exists, and the argv log stays empty.
func TestPipelineRefusesAnIncompleteBinding(t *testing.T) {
	for name, call := range everyPipelineCall() {
		t.Run(name, func(t *testing.T) {
			// Not parallel: the log destination is process-wide state.
			var logged bytes.Buffer
			restore := captureLog(t, &logged)
			defer restore()

			rec := &recorder{}
			_, err := call(serviceWith(rec), Binding{Context: "prod-us-west"}, manifest)

			if err == nil || !strings.Contains(err.Error(), ErrUnbound.Error()) {
				t.Fatalf("error = %v, want ErrUnbound", err)
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

// A call with nothing to act on spawns nothing either. It is a caller's mistake
// rather than a user's, and the refusal is what stops it from reaching kubectl
// as a bare `apply` against whatever the process happens to have on stdin.
func TestPipelineRefusesAnEmptyTarget(t *testing.T) {
	t.Parallel()

	for name, call := range everyPipelineCall() {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := &recorder{}
			_, err := call(serviceWith(rec), bound(), "   ")

			if err == nil || !strings.Contains(err.Error(), errNoManifest.Error()) {
				t.Fatalf("error = %v, want a refusal naming the missing manifest", err)
			}
			if len(rec.calls) != 0 {
				t.Errorf("kubectl was invoked with %v, want no invocation at all", rec.calls)
			}
		})
	}
}

// everyPipelineCall is the set both refusal tests run over, so a subcommand
// added without a guard fails them rather than quietly not being covered.
func everyPipelineCall() map[string]func(*Service, Binding, string) (Result, error) {
	return map[string]func(*Service, Binding, string) (Result, error){
		"validate": func(s *Service, b Binding, target string) (Result, error) {
			return s.Validate(context.Background(), b, target, false, false)
		},
		"diff": func(s *Service, b Binding, target string) (Result, error) {
			return s.Diff(context.Background(), b, target, false, false)
		},
		"apply": func(s *Service, b Binding, target string) (Result, error) {
			return s.Apply(context.Background(), b, target, false, false)
		},
		"delete preview": func(s *Service, b Binding, target string) (Result, error) {
			return s.DeletePreview(context.Background(), b, target, false)
		},
		"delete": func(s *Service, b Binding, target string) (Result, error) {
			return s.Delete(context.Background(), b, target, false)
		},
	}
}

// kubectl diff's exit code is its answer, and the three cases have to survive
// the trip back as themselves: this package reports what kubectl said and leaves
// "no changes" versus "changes" versus "it failed" to the caller.
func TestDiffCarriesItsExitCodeAndOutput(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		result Result
	}{
		{name: "no changes", result: Result{ExitCode: 0}},
		{name: "changes", result: Result{ExitCode: 1, Stdout: "- replicas: 2\n+ replicas: 3\n"}},
		{name: "failed", result: Result{ExitCode: 2, Stderr: "Error from server (NotFound)"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			rec := &recorder{result: test.result}
			got, err := serviceWith(rec).Diff(context.Background(), bound(), manifest, false, false)
			if err != nil {
				t.Fatalf("Diff: %v", err)
			}
			if got.ExitCode != test.result.ExitCode {
				t.Errorf("exit code = %d, want %d", got.ExitCode, test.result.ExitCode)
			}
			if got.Stdout != test.result.Stdout || got.Stderr != test.result.Stderr {
				t.Errorf("output = %q/%q, want %q/%q",
					got.Stdout, got.Stderr, test.result.Stdout, test.result.Stderr)
			}
		})
	}
}

// A path holding shell metacharacters is inert: it reaches kubectl as one
// argument inside its own flag, and no shell ever sees it (CLAUDE.md).
func TestAMetacharacterPathIsOneArgument(t *testing.T) {
	t.Parallel()

	hostile := "/repo/we;rm -rf $HOME/`id`.yaml"
	rec := &recorder{}
	if _, err := serviceWith(rec).Apply(context.Background(), bound(), hostile, false, false); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	argv := rec.calls[0]
	if !slices.Contains(argv, "--filename="+hostile) {
		t.Errorf("argv = %v, want the path carried whole inside its own flag", argv)
	}
}
