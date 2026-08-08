package kubeexec

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// The mutation pipeline's subcommands (DESIGN.md §6.1): validate, diff, apply,
// and the delete pair that follows the same shape.
//
// Every one of them goes through Binding.argv, which is the whole reason they
// are here rather than in a package of their own — these are the invocations
// that change a cluster, and they are the last place an implicit target could
// be tolerated. Nothing in this file builds an argument vector itself.
//
// What this file deliberately does NOT do is decide anything. It runs no
// sequence, holds no run in progress, and reads none of what kubectl printed:
// the order validate → diff → confirm → apply is the pipeline, and a pipeline
// is a thing with states, a user in the middle of it, and a dialog that has to
// be answered. That belongs to the caller. Here there are five invocations, and
// a caller that ran the fourth without the first three would be doing something
// this package cannot see and internal/app refuses.

// ErrNoManifest reports a call with no manifest path to act on. It is returned
// before any process is created, and it is a programming error rather than a
// user-facing one: internal/app resolves and confines every path before it gets
// here, so an empty target means a caller skipped that step.
var errNoManifest = errors.New("no manifest path to act on")

// Validate is step 1: does the cluster accept these manifests at all?
//
// `kubectl apply --dry-run=server` rather than a client-side check, because the
// failures worth blocking on are the ones only the API server knows — an
// admission webhook's refusal, a CRD that is not installed, a field the target
// version dropped, an RBAC rule that denies the write. A client dry run would
// pass all four and let the apply be the thing that discovers them.
//
// It mirrors Apply's own flags rather than running a simplified command. A
// validation performed under different semantics from the apply is a validation
// of a different operation, and would say yes to an apply that is about to say
// no.
//
// A non-zero exit is a Result carrying kubectl's stderr, which is what the UI
// blocks on and shows. See the package comment for why that is not an error.
func (s *Service) Validate(ctx context.Context, b Binding, target string, recursive bool) (Result, error) {
	args, err := applyArgs(target, recursive, true)
	if err != nil {
		return Result{}, err
	}
	return s.exec(ctx, b, args...)
}

// Diff is step 2: what would change, as kubectl's own unified diff.
//
// The exit code is the answer, not just a status. `kubectl diff` exits 0 when
// the cluster already matches, 1 when it does not, and above 1 when the command
// itself failed — so "no changes" arrives here as a zero exit with empty stdout,
// which is the first-class result DESIGN.md §6.1 asks for rather than an empty
// screen. Distinguishing the three is the caller's, because this package
// returns what kubectl said and does not interpret it.
func (s *Service) Diff(ctx context.Context, b Binding, target string, recursive bool) (Result, error) {
	args, err := diffArgs(target, recursive)
	if err != nil {
		return Result{}, err
	}
	return s.exec(ctx, b, args...)
}

// Apply is step 4, the one invocation here that changes a cluster.
//
// It is deliberately identical to Validate minus the dry run. The two commands
// differing in anything else would make the preview a prediction about a
// different command, and a preview that is not the operation is worse than no
// preview: it is a preview the user trusts.
//
// Confirmation is not enforced here and cannot be. This package sees an argv and
// a binding, not a dialog — internal/app is where a protected binding refuses an
// apply that arrives without the context name typed, before this is ever called.
func (s *Service) Apply(ctx context.Context, b Binding, target string, recursive bool) (Result, error) {
	args, err := applyArgs(target, recursive, false)
	if err != nil {
		return Result{}, err
	}
	return s.exec(ctx, b, args...)
}

// DeletePreview lists what a delete would remove, without removing it.
//
// It is the delete half's diff step: `kubectl delete --dry-run=server` prints
// one line per object it resolved, so the confirm dialog can name the objects
// rather than the file that happens to contain them. A file that has been edited
// since it was applied is exactly the case this exists for — the objects that go
// are the ones the file names now, and the user is entitled to read that list
// before agreeing to it.
func (s *Service) DeletePreview(ctx context.Context, b Binding, target string, recursive bool) (Result, error) {
	args, err := deleteArgs(target, recursive, true)
	if err != nil {
		return Result{}, err
	}
	return s.exec(ctx, b, args...)
}

// Delete removes the objects the manifests name. It is DeletePreview minus the
// dry run, for the reason Apply is Validate minus the dry run.
func (s *Service) Delete(ctx context.Context, b Binding, target string, recursive bool) (Result, error) {
	args, err := deleteArgs(target, recursive, false)
	if err != nil {
		return Result{}, err
	}
	return s.exec(ctx, b, args...)
}

// applyArgs builds the argument list for `kubectl apply`, dry run or not.
//
// Validate and Apply share it rather than each writing their own, which is what
// makes "the preview is the operation" a property of the code instead of a
// promise in two doc comments that can drift apart.
//
// There is no --server-side here, and its absence is a decision rather than an
// omission (#69). m6t applies the way the rest of a team applies, and the rest
// of a team runs `kubectl apply`. Server-side apply records per-field ownership,
// so an object whose fields are owned by `kubectl-client-side-apply` — which is
// every object anyone has ever applied normally — refuses a server-side apply
// from a different manager. That is a one-time migration only if nothing else
// ever writes to the cluster again; where colleagues and CI keep running plain
// `kubectl apply`, ownership returns to them and the next apply conflicts
// again. Forcing past it every time is server-side apply with the only property
// it buys switched off, which is worse than not using it. It comes back when
// there is a reason for a whole team to move at once, not as a checkbox.
func applyArgs(target string, recursive, dryRun bool) ([]string, error) {
	args := []string{"apply"}
	if dryRun {
		args = append(args, "--dry-run=server")
	}
	return withSource(args, target, recursive)
}

// diffArgs builds the argument list for `kubectl diff`.
func diffArgs(target string, recursive bool) ([]string, error) {
	return withSource([]string{"diff"}, target, recursive)
}

// deleteArgs builds the argument list for `kubectl delete`, dry run or not.
func deleteArgs(target string, recursive, dryRun bool) ([]string, error) {
	args := []string{"delete"}
	if dryRun {
		args = append(args, "--dry-run=server")
	}
	return withSource(args, target, recursive)
}

// withSource appends the manifest source — the file or directory kubectl reads —
// to a subcommand's arguments.
//
// `--filename=<path>` rather than `-f <path>` for the reason Binding.argv gives
// about the context: a value in its own argument can be read as a flag, and a
// value inside its flag cannot. The paths that reach here are absolute and come
// from a confined resolution in internal/app, so this is the second guard rather
// than the only one — which is the arrangement internal/watch already uses for
// the same class of input.
//
// `--recursive` is set for a directory and only for a directory. Without it
// kubectl reads a directory's immediate children and silently ignores every
// subdirectory, so applying `prod/` in the ordinary one-directory-per-namespace
// layout would apply nothing at all and report success.
func withSource(args []string, target string, recursive bool) ([]string, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return nil, fmt.Errorf("running kubectl %s: %w", strings.Join(args, " "), errNoManifest)
	}

	args = append(args, "--filename="+trimmed)
	if recursive {
		args = append(args, "--recursive")
	}
	return args, nil
}
