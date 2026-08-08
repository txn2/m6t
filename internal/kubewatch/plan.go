package kubewatch

import (
	"fmt"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// group is one list-and-watch connection: a resource in a namespace, and the
// declared objects it is responsible for.
type group struct {
	// client is already scoped to the resource and the namespace.
	client dynamic.ResourceInterface

	// key is the resource and namespace this group covers, kept for a stable
	// ordering and for the messages that name what could not be read.
	key groupKey

	// names maps an object's name to the indices it occupies in the planned
	// order. A slice rather than a single index because a repository is allowed
	// to declare the same object in two files, and a plan that kept only the
	// last one would leave the first row of the panel permanently NotFound.
	names map[string][]int
}

// groupKey identifies a group.
type groupKey struct {
	resource  schema.GroupVersionResource
	namespace string
}

// plan turns declared objects into the rows the panel shows and the connections
// that keep them current.
//
// The two are built together because they have to agree: every row is either
// owned by exactly one group or is a row no group can answer for, and building
// them separately is how a row ends up with no owner and sits NotFound over an
// object that is running.
//
// The returned order is the declaration order, which internal/manifest has
// already sorted. Groups are sorted so that a plan is reproducible — the map
// they are collected in is not.
func plan(
	mapper meta.RESTMapper,
	client dynamic.Interface,
	objects []Object,
	fallback string,
) ([]Status, []group) {
	order := make([]Status, 0, len(objects))
	byKey := make(map[groupKey]*group)

	for _, declared := range objects {
		mapping, err := resolve(mapper, declared)
		if err != nil {
			order = append(order, unknown(declared, err))
			continue
		}

		namespace := ""
		if mapping.Scope.Name() == meta.RESTScopeNameNamespace {
			namespace = declared.Namespace
			if namespace == "" {
				namespace = fallback
			}
		}

		index := len(order)
		order = append(order, Status{
			APIVersion: declared.APIVersion,
			Kind:       declared.Kind,
			Namespace:  namespace,
			Name:       declared.Name,
			File:       declared.File,
			Health:     HealthNotFound,
		})

		key := groupKey{resource: mapping.Resource, namespace: namespace}
		owner, ok := byKey[key]
		if !ok {
			owner = &group{client: scoped(client, key), key: key, names: make(map[string][]int)}
			byKey[key] = owner
		}
		owner.names[declared.Name] = append(owner.names[declared.Name], index)
	}

	return order, sorted(byKey)
}

// resolve maps a declared object's apiVersion and kind onto the resource the
// API server serves it as.
//
// The failure is wrapped with the apiVersion and kind because the row it lands
// on shows the message and the mapper's own text does not always name what it
// failed on — "no matches for kind" reads very differently next to the version
// that was actually asked for, which is the usual culprit when a CRD is
// installed at v1beta1 and the manifest says v1.
func resolve(mapper meta.RESTMapper, declared Object) (*meta.RESTMapping, error) {
	gvk := schema.FromAPIVersionAndKind(declared.APIVersion, declared.Kind)
	mapping, err := mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return nil, fmt.Errorf("this cluster does not serve %s %s: %w",
			declared.APIVersion, declared.Kind, err)
	}
	return mapping, nil
}

// unknown is the row for an object whose kind this cluster does not serve.
//
// It is a state rather than an omission. A CRD that is not installed is the
// ordinary reason, and it is exactly the thing a user needs told: a panel that
// silently dropped the row would look like a project that declares fewer
// objects than it does.
func unknown(declared Object, err error) Status {
	return Status{
		APIVersion: declared.APIVersion,
		Kind:       declared.Kind,
		Namespace:  declared.Namespace,
		Name:       declared.Name,
		File:       declared.File,
		Health:     HealthUnknown,
		Message:    err.Error(),
	}
}

// scoped narrows the dynamic client to one group's resource and namespace. An
// empty namespace is a cluster-scoped resource, which client-go spells as not
// calling Namespace at all.
func scoped(client dynamic.Interface, key groupKey) dynamic.ResourceInterface {
	resource := client.Resource(key.resource)
	if key.namespace == "" {
		return resource
	}
	return resource.Namespace(key.namespace)
}

// sorted flattens the collected groups into a reproducible order.
func sorted(byKey map[groupKey]*group) []group {
	groups := make([]group, 0, len(byKey))
	for _, g := range byKey {
		groups = append(groups, *g)
	}
	slices.SortFunc(groups, func(a, b group) int {
		if by := strings.Compare(a.key.resource.String(), b.key.resource.String()); by != 0 {
			return by
		}
		return strings.Compare(a.key.namespace, b.key.namespace)
	})
	return groups
}

// describe names what a group covers, for a message about it.
func (g group) describe() string {
	if g.key.namespace == "" {
		return g.key.resource.Resource
	}
	return g.key.resource.Resource + " in " + g.key.namespace
}

// options builds the list and watch request for a group.
//
// A group holding one object is narrowed with a field selector, which is the
// difference between reading one Secret and reading every Secret in the
// namespace — the same request, and a very different thing to ask a cluster
// for. Above one object the selector cannot express the set (field selectors
// take a single value per key), so the group lists the resource and filters by
// name on the way in.
func (g group) options() metav1.ListOptions {
	if len(g.names) != 1 {
		return metav1.ListOptions{}
	}
	for name := range g.names {
		return metav1.ListOptions{
			FieldSelector: fields.OneTermEqualSelector("metadata.name", name).String(),
		}
	}
	return metav1.ListOptions{}
}
