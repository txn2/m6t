package kubewatch

import (
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

// connectTimeout bounds the requests made while building cluster access.
//
// It covers discovery, not the watches: a watch is a long-lived stream and a
// deadline on it would be a disconnection on a schedule. What this protects is
// the step that can hang without ever failing — an exec credential plugin
// waiting on a browser, or an API server that accepted the TCP connection and
// then stopped answering. Without it, a project bound to an unreachable cluster
// would sit on PhaseConnecting forever instead of cycling through
// PhaseReconnecting with a message.
const connectTimeout = 30 * time.Second

// userAgent identifies m6t's watches in an API server's audit log. A cluster
// administrator looking at where a stream of watch requests came from is
// entitled to an answer better than "Go-http-client".
const userAgent = "m6t/kubewatch"

// Connect builds cluster access for a kubeconfig context: a dynamic client for
// the objects, and a RESTMapper for turning a manifest's apiVersion and kind
// into the resource the API server serves them as.
//
// The context is named explicitly and the kubeconfig's current-context is
// overridden, never consulted — the same rule internal/kubeexec holds for
// kubectl and for the same reason (DESIGN.md §4). This one is read-only, so
// getting it wrong would show the wrong cluster's health rather than mutate the
// wrong cluster, which is a smaller accident and still the accident the app
// exists to prevent.
//
// Discovery happens here rather than lazily, so that a cluster that cannot be
// reached fails at connection time with a message, instead of at the first
// object with a message about that object.
func Connect(contextName string) (dynamic.Interface, meta.RESTMapper, error) {
	config, err := restConfig(contextName)
	if err != nil {
		return nil, nil, err
	}

	client, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, nil, fmt.Errorf("building a client for %s: %w", contextName, err)
	}

	mapper, err := apiMapper(config, contextName)
	if err != nil {
		return nil, nil, err
	}
	return client, mapper, nil
}

// restConfig resolves the named context into connection settings.
func restConfig(contextName string) (*rest.Config, error) {
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(),
		&clientcmd.ConfigOverrides{CurrentContext: contextName},
	)

	config, err := loader.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("resolving the kube context %s: %w", contextName, err)
	}

	config.Timeout = connectTimeout
	config.UserAgent = userAgent
	return config, nil
}

// apiMapper discovers what the cluster serves and builds the kind-to-resource
// mapping from it.
//
// A discovery that partially fails — one aggregated API service down, which is
// an ordinary state in a cluster running metrics-server or a service mesh — is
// not fatal. The groups that did answer are enough to map every core kind, and
// refusing to watch anything because an unrelated extension is unhealthy would
// make m6t less available than the cluster it is looking at.
func apiMapper(config *rest.Config, contextName string) (meta.RESTMapper, error) {
	client, err := discovery.NewDiscoveryClientForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("building a discovery client for %s: %w", contextName, err)
	}

	groups, err := restmapper.GetAPIGroupResources(client)
	if err != nil && len(groups) == 0 {
		return nil, fmt.Errorf("discovering the API of %s: %w", contextName, err)
	}
	return restmapper.NewDiscoveryRESTMapper(groups), nil
}
