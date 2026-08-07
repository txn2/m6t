// Package tools reports which of the external binaries m6t drives are actually
// installed, and what version they are (DESIGN.md §2, §3.2).
//
// m6t is a workbench over the user's own `git`, `kubectl` and `helm`. When one
// of them is missing, the honest answer is a named degraded state — "helm not
// found on PATH — Helm features disabled" — and not a subprocess failure
// surfacing from underneath a button the user pressed. This package produces
// that answer.
//
// Every field of a Tool is a state, never an error: a machine without helm is
// an ordinary machine, and a package that returned an error for it would make
// every caller decide again whether that error was fatal. Detection is done on
// demand rather than cached, because installing a tool while m6t is open should
// not need a restart, and three `--version` calls cost milliseconds.
//
// It imports nothing first-party and is composed by internal/app.
package tools

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// detectTimeout bounds one version probe.
//
// Short on purpose. These are local, offline calls that print a constant and
// exit; a `--version` that has not answered in this long is a binary wedged on
// a stalled network mount, and startup must not wait on it.
const detectTimeout = 5 * time.Second

// Tool is one external binary's state.
type Tool struct {
	// Name is the executable's name, which is also how the UI refers to it.
	Name string `json:"name"`

	// Path is where it was found on PATH, or "" when it was not found. It is
	// reported because "helm is installed" and "the helm m6t will run is the
	// one in /opt/homebrew/bin" are different facts, and the second is the one
	// that resolves an argument about which version is in play.
	Path string `json:"path"`

	// Version is the tool's own version string, cleaned of its prefix, or ""
	// when the probe produced nothing usable.
	Version string `json:"version"`

	// Found is whether an executable of this name exists on PATH at all. It is
	// the flag the UI disables features on: a tool that is present but whose
	// version probe failed is still a tool the user can run.
	Found bool `json:"found"`

	// Problem is a sentence describing why the probe did not produce a
	// version, or "" when it did. A found tool with a Problem is degraded, not
	// absent — an old kubectl whose flags differ, or a helm that exited
	// non-zero — and the UI shows the sentence rather than hiding the tool.
	Problem string `json:"problem"`
}

// probe describes how to ask one tool its version.
type probe struct {
	// name is the executable to look for on PATH.
	name string

	// args is the version invocation. Each is chosen to print one short line
	// and exit without contacting anything: `kubectl version` without
	// `--client` would contact an API server, which is a network call in a
	// function that runs at startup.
	args []string

	// prefix is the boilerplate the tool puts in front of the number, trimmed
	// so the UI shows "2.43.0" rather than "git version 2.43.0".
	prefix string
}

// probes are the three binaries DESIGN.md §2 names as runtime requirements.
//
// helm's `--short` is what keeps its answer a version rather than the
// `version.BuildInfo{Version:"v3.14.0", GitCommit:...}` struct dump its default
// output is.
var probes = []probe{
	{name: "git", args: []string{"--version"}, prefix: "git version "},
	{name: "kubectl", args: []string{"version", "--client"}, prefix: "Client Version: "},
	{name: "helm", args: []string{"version", "--short"}, prefix: ""},
}

// Detect reports the state of every tool m6t drives, in a fixed order so the UI
// does not reshuffle its list between two refreshes.
func Detect(ctx context.Context) []Tool {
	detected := make([]Tool, 0, len(probes))
	for _, p := range probes {
		detected = append(detected, p.detect(ctx))
	}
	return detected
}

// detect resolves one tool and asks it its version.
func (p probe) detect(ctx context.Context) Tool {
	binary, err := exec.LookPath(p.name)
	if err != nil {
		return Tool{Name: p.name, Problem: p.name + " was not found on PATH"}
	}

	found := Tool{Name: p.name, Path: binary, Found: true}

	version, err := p.version(ctx, binary)
	if err != nil {
		found.Problem = err.Error()
		return found
	}
	if version == "" {
		found.Problem = p.name + " reported no version"
		return found
	}

	found.Version = version
	return found
}

// version runs the probe and returns the cleaned version string.
func (p probe) version(ctx context.Context, binary string) (string, error) {
	deadline, cancel := context.WithTimeout(ctx, detectTimeout)
	defer cancel()

	cmd := exec.CommandContext(deadline, binary, p.args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	cmd.Stdin = strings.NewReader("")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// A tool that is installed but whose version probe fails — a wrapper
		// script, a build too old for these flags — is degraded, not absent,
		// so this becomes a Problem on a found tool. The tool's own stderr
		// carries the reason and is passed through rather than summarized
		// (CLAUDE.md).
		return "", fmt.Errorf("running %s %s: %w: %s",
			p.name, strings.Join(p.args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return clean(stdout.String(), p.prefix), nil
}

// clean reduces a version command's output to the first non-empty line with the
// tool's boilerplate prefix removed.
//
// The first line rather than the whole output because `kubectl version
// --client` prints a Kustomize version on a second line, and a UI element sized
// for a version number is not the place for it.
func clean(out, prefix string) string {
	for line := range strings.SplitSeq(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		return strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
	}
	return ""
}
