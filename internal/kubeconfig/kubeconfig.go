// Package kubeconfig reads the user's kubeconfig to answer one question: which
// contexts is there to bind a project to (DESIGN.md §4)?
//
// It is read-only in the strongest sense — it opens the file, lists what is in
// it, and never writes, never selects a current-context, and never builds a
// client. m6t is a workbench over the user's own tooling and credentials, not a
// credential store (DESIGN.md §1), so nothing here retains a token, a client
// certificate or a password: the only fields that leave this package are the
// names a user picks a context by.
//
// The loading rules are client-go's rather than a hand-rolled parse, because
// "which file, and which entry wins" is not one rule. KUBECONFIG is a
// path-list, the files merge with first-wins precedence per key, and a user
// whose context list here disagreed with the one `kubectl config get-contexts`
// prints would be looking at a binding UI that names clusters kubectl cannot
// reach.
//
// It imports nothing first-party and is composed by internal/app, like every
// other service (CLAUDE.md, DESIGN.md §3.2).
package kubeconfig

import (
	"fmt"
	"sort"

	"k8s.io/client-go/tools/clientcmd"
)

// Context is one entry a project can be bound to.
//
// Namespace is the context's *own* default namespace, which is a suggestion and
// not a binding: m6t stores the namespace it will pass to kubectl on the project
// (DESIGN.md §4) and never falls back to this one at call time. It is carried so
// the settings UI can prefill the field when a context is picked, which is the
// difference between a form that knows what the user's kubeconfig already says
// and a form that makes them retype it.
type Context struct {
	// Name is the context name, which is what `--context` takes.
	Name string `json:"name"`

	// Cluster and User are shown beside the name to tell apart two contexts
	// that differ only in who they authenticate as — the ordinary shape of an
	// admin and a read-only entry against one cluster.
	Cluster string `json:"cluster"`
	User    string `json:"user"`

	// Namespace is the context's default namespace, or "" when it sets none.
	Namespace string `json:"namespace"`

	// Current marks the kubeconfig's current-context. It is shown as a hint
	// and carries no authority: m6t never binds a project to it implicitly,
	// because "whatever kubectl would have done" is how a manifest lands in
	// the wrong cluster (DESIGN.md §4).
	Current bool `json:"current"`
}

// Config is what one read of the kubeconfig found.
type Config struct {
	// Contexts are the available bindings, sorted by name. Sorted rather than
	// in file order because the underlying representation is a map: an
	// unsorted list would reorder itself between two reads of an unchanged
	// file, and a select whose options move is a select that mis-binds.
	Contexts []Context `json:"contexts"`

	// Sources are the files the loading rules consulted, in precedence order.
	//
	// They are carried for the empty case. "No contexts found" is a dead end;
	// "no contexts found in ~/.kube/config" tells a user whose config lives
	// somewhere else that KUBECONFIG is not set the way they think it is.
	Sources []string `json:"sources"`
}

// Load reads the kubeconfig the user's environment points at.
//
// A kubeconfig that does not exist is an empty Config and no error: a machine
// with no clusters configured is an ordinary state with a clear thing for the
// UI to say, not a failure. A file that exists and will not parse IS an error —
// the user has a broken kubeconfig and every kubectl call they make is failing
// the same way, so saying so beats showing them an empty list that implies they
// have no clusters.
func Load() (Config, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()

	raw, err := rules.Load()
	if err != nil {
		return Config{}, fmt.Errorf("reading kubeconfig: %w", err)
	}

	contexts := make([]Context, 0, len(raw.Contexts))
	for name, entry := range raw.Contexts {
		contexts = append(contexts, Context{
			Name:      name,
			Cluster:   entry.Cluster,
			User:      entry.AuthInfo,
			Namespace: entry.Namespace,
			Current:   name == raw.CurrentContext,
		})
	}
	sort.Slice(contexts, func(i, j int) bool { return contexts[i].Name < contexts[j].Name })

	return Config{Contexts: contexts, Sources: rules.GetLoadingPrecedence()}, nil
}
