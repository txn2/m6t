import { useEffect, useState } from "react";
import type { Kube } from "../lib/kube";

export interface NamespaceFieldProps {
  /** The context whose namespaces are listed; "" lists none, because there is
   * no cluster to ask yet. */
  readonly context: string;
  readonly value: string;
  /** What the empty option says — "default" on a project, "inherit" on a
   * folder override. */
  readonly placeholder: string;
  readonly label: string;
  readonly kube: Kube;
  onChange: (next: string) => void;
}

/**
 * The context whose namespaces a field should offer: the one chosen, or the one
 * inherited while nothing is chosen.
 *
 * It is a function rather than a ternary at the call site because the folder
 * dialog is at its branch ceiling, and this is the branch worth moving: a
 * namespace-only override leaves the context field empty on purpose, and it is
 * the commonest override there is.
 */
export function namespaceSource(chosen: string, inherited: string): string {
  return chosen === "" ? inherited : chosen;
}

/** What the last listing did. */
type Listing = "idle" | "loading" | "ready" | "failed";

/**
 * The namespace picker: the namespaces the chosen context's cluster actually
 * has.
 *
 * It is a dropdown for the reason the context beside it is one — the set is
 * knowable, so making the user type a name the cluster could have told them is
 * asking them to be a database. `kubectl get namespaces` against the bound
 * context is the whole mechanism.
 *
 * Two rules keep the list from losing a binding it did not produce:
 *
 *   - the stored value is always an option, even when the cluster did not list
 *     it. Selecting a context whose namespaces have not arrived — or one where
 *     the namespace lives under a name the user has RBAC to use but not to
 *     enumerate — must not silently clear a namespace that is already bound.
 *   - a listing that fails falls back to a text field carrying kubectl's own
 *     reason. Listing namespaces is a distinct RBAC permission from using one,
 *     so a dropdown that came back empty would lock a user out of a namespace
 *     they can deploy to perfectly well. The dropdown is the path; this is the
 *     door for when the cluster will not answer.
 */
export function NamespaceField({
  context,
  value,
  placeholder,
  label,
  kube,
  onChange,
}: NamespaceFieldProps) {
  const [namespaces, setNamespaces] = useState<readonly string[]>([]);
  const [listing, setListing] = useState<Listing>("idle");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (context === "") {
      setNamespaces([]);
      setListing("idle");
      return;
    }
    let current = true;
    setListing("loading");
    void (async () => {
      try {
        const listed = await kube.namespaces(context);
        if (current) {
          setNamespaces(listed);
          setListing("ready");
        }
      } catch (error: unknown) {
        if (current) {
          setNamespaces([]);
          setFailure(error instanceof Error ? error.message : String(error));
          setListing("failed");
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [context, kube]);

  if (listing === "failed") {
    return (
      <>
        <label className="settings__field">
          <span>namespace</span>
          <input
            type="text"
            value={value}
            placeholder={placeholder}
            aria-label={label}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </label>
        <p className="settings__note">{failure}</p>
      </>
    );
  }

  return (
    <label className="settings__field">
      <span>namespace</span>
      <select
        value={value}
        aria-label={label}
        data-testid={`namespaces-${label}`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">
          {listing === "loading" ? "Reading namespaces" : placeholder}
        </option>
        {options(namespaces, value).map((namespace) => (
          <option key={namespace} value={namespace}>
            {namespace}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The namespaces to offer: what the cluster listed, plus the one already
 * bound if the listing did not include it.
 *
 * A select whose value is not among its options renders as blank and reports
 * "" on the next change — which would turn "the list has not arrived yet" into
 * "this project has no namespace", silently, on a binding that was correct.
 */
export function options(listed: readonly string[], current: string): string[] {
  if (current === "" || listed.includes(current)) {
    return [...listed];
  }
  return [current, ...listed];
}

export interface ContextFieldProps {
  readonly value: string;
  readonly contexts: readonly { readonly name: string; readonly current: boolean }[];
  /** What the empty option says: "unbound" on a project, "inherit" on a
   * folder. */
  readonly emptyLabel: string;
  readonly label: string;
  onChange: (next: string) => void;
}

/**
 * The context picker, shared by the project default and the folder dialog.
 *
 * The set of contexts is whatever the user's kubeconfig holds, read at startup:
 * a context m6t cannot find is one kubectl could not use either. The
 * current-context is labelled and nothing more — binding stays something the
 * user does on purpose (DESIGN.md §4).
 */
export function ContextField({
  value,
  contexts,
  emptyLabel,
  label,
  onChange,
}: ContextFieldProps) {
  return (
    <label className="settings__field">
      <span>context</span>
      <select
        value={value}
        aria-label={label}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{emptyLabel}</option>
        {contexts.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.name}
            {entry.current ? " (kubectl's current)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
