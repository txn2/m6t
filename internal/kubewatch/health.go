package kubewatch

// The vocabulary the panel reads: what state a connection is in, and what state
// an object is in. They are separate types because they answer separate
// questions — see Snapshot — and they live in their own file because they are
// the part of this package's surface that is a wire contract rather than an
// API: renaming a constant here changes what the frontend has to match.

// Phase is what is happening to a project's connection to its cluster.
//
// It is reported separately from the object list rather than folded into it,
// because the two answer different questions and a UI that merged them would
// have to invent a health value meaning "we no longer know". The objects say
// what was last observed; the phase says whether that observation is still
// being kept up to date.
type Phase string

// The phases. These are wire values read by the frontend, so renaming one is a
// protocol change.
const (
	// PhaseIdle means there is nothing to watch: the path is unbound, or the
	// checkout declares no Kubernetes objects. It is not an error and no
	// connection is attempted.
	PhaseIdle Phase = "idle"

	// PhaseConnecting covers building a client and discovering the API surface,
	// which is the step that can hang behind an exec credential plugin.
	PhaseConnecting Phase = "connecting"

	// PhaseWatching means every group has listed and is following changes.
	PhaseWatching Phase = "watching"

	// PhaseReconnecting means the connection failed and is being retried. The
	// Reason carries what the API server or the transport said.
	PhaseReconnecting Phase = "reconnecting"

	// PhaseUnauthorized means the cluster refused this user. It is still
	// retried, on the same backoff: an expired SSO session is fixed in another
	// window and the panel should recover on its own rather than needing to be
	// poked.
	PhaseUnauthorized Phase = "unauthorized"
)

// Health is one object's state, as kstatus computes it.
//
// The values are kstatus's own strings rather than a set of this package's
// invention. A user reading "InProgress" here and "InProgress" from
// `kubectl wait` or a Flux/Argo status is reading the same verdict computed by
// the same code, and a private vocabulary would make m6t the one tool whose
// opinion has to be translated.
type Health string

// The health values. Wire values, like the phases.
const (
	// HealthUnknown means no verdict: the kind is not served by this cluster,
	// or the user cannot read it. Message says which.
	HealthUnknown Health = "Unknown"

	// HealthCurrent means the object has reached its desired state.
	HealthCurrent Health = "Current"

	// HealthInProgress means it is still reconciling.
	HealthInProgress Health = "InProgress"

	// HealthFailed means it has reported a failure.
	HealthFailed Health = "Failed"

	// HealthTerminating means it is being deleted.
	HealthTerminating Health = "Terminating"

	// HealthNotFound means the repository declares it and the cluster does not
	// have it. It is the state a never-applied manifest sits in, and it is
	// called out in the panel rather than hidden, because "declared but absent"
	// is the most common thing a user opens this panel to find out.
	HealthNotFound Health = "NotFound"
)
