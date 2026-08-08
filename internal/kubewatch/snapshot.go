package kubewatch

// What a session reports: the objects a checkout declares, what the cluster
// says about each, and what could not be read. Every type here crosses the
// Wails bridge, which is the constraint that shapes them — see Status on why
// the identity fields are spelled out rather than embedded.

// Object is one object a project's checkout declares.
//
// It mirrors what internal/manifest produces without importing it: backend
// services are siblings and declare their own seams (DESIGN.md §3.2), the same
// arrangement kubeexec.Binding has with project.Binding.
type Object struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`

	// Namespace is what the manifest states, which is routinely nothing.
	// Resolving an empty one needs to know whether the kind is namespaced at
	// all, which needs discovery — so it is resolved here rather than by
	// whatever produced the Object. See plan.
	Namespace string `json:"namespace"`

	Name string `json:"name"`

	// File is where the declaration lives, repository-relative.
	File string `json:"file"`
}

// Notice is something the checkout could not be read for, carried through to
// the panel unchanged. This package neither produces nor interprets them; they
// arrive on the Manifests seam and are reported beside the objects, because a
// panel listing four objects out of a file that declares five has to say so.
type Notice struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
}

// Status is one declared object and what the cluster says about it.
//
// The identity fields are spelled out rather than embedding Object, because
// this type crosses the Wails bridge and an embedded struct is the shape whose
// generated TypeScript differs from the JSON that is actually sent.
type Status struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`

	// Namespace is the RESOLVED namespace: what the manifest stated, or the
	// binding's namespace when it stated none, or empty for a cluster-scoped
	// kind. It is the resolved value because it is the answer to "where is this
	// object", and the unresolved one would show empty for the majority of
	// manifests that leave it to the apply.
	Namespace string `json:"namespace"`

	Name string `json:"name"`
	File string `json:"file"`

	Health Health `json:"health"`

	// Message is kstatus's own sentence for a non-Current object, or the reason
	// there is no verdict. Empty when there is nothing to add.
	Message string `json:"message"`
}

// Snapshot is everything the panel draws: the connection's state, and the last
// observed state of every declared object.
type Snapshot struct {
	Phase Phase `json:"phase"`

	// Reason explains a phase that needs explaining — the error behind
	// PhaseReconnecting, the missing binding behind PhaseIdle. Empty for
	// PhaseWatching, which explains itself.
	Reason string `json:"reason"`

	// Objects are in the order the checkout declares them, which is
	// internal/manifest's stable sort. A panel whose rows moved as objects
	// changed health would be unreadable during exactly the rollout it exists
	// to show.
	Objects []Status `json:"objects"`

	// Notices are what could not be indexed.
	Notices []Notice `json:"notices"`
}
