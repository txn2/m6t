import { useEffect, useState } from "react";
import type { KubeContext, Kube, Scope } from "../lib/kube";
import { overrideAt } from "../lib/kube";
import type { Project } from "../lib/projects";
import { ContextField, NamespaceField, namespaceSource } from "./NamespaceField";
import { Protected } from "./ProjectPanel";
/** The Kubernetes wheel, vendored with the file-type marks (see Icon.tsx). */
import kubernetesMark from "../icons/material/kubernetes.svg";

export interface FolderBindingProps {
  /** The folder being bound, repository-relative and slash-separated. */
  readonly path: string;
  /** The override this folder already carries, or null when it only inherits
   * one. It is what decides whether "Remove override" is offered. */
  readonly existing: Scope | null;
  /** What the folder resolves to today, shown so the user can see what they
   * are overriding rather than guessing. */
  readonly inherited: string;
  /**
   * The context the folder inherits, which is the cluster its namespaces come
   * from while the context field is left inheriting.
   *
   * Without it the commonest override — namespace only, on a repository whose
   * environments share a cluster — would be the one case with no list to pick
   * from, because the field above it is deliberately empty.
   */
  readonly inheritedContext: string;
  readonly contexts: readonly KubeContext[];
  readonly kube: Kube;
  /** Rejects with the registry's message when the path is refused. */
  onSave: (context: string, namespace: string, guarded: boolean) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}

/**
 * The dialog that binds one folder to a context and namespace (DESIGN.md §4).
 *
 * It is opened from the folder itself, in the tree, rather than from a list of
 * paths in a settings screen. A repository laid out one directory per cluster
 * is one the user reads as a tree, and the moment they know which cluster a
 * directory belongs to is the moment they are looking at it — a form that made
 * them retype the path they were pointing at would be asking them to do the
 * navigation twice, and to get it right from memory the second time.
 *
 * Both fields default to inheriting. That is what makes the commonest case one
 * field: a repository whose environments live on one cluster and differ only in
 * namespace sets the namespace here and leaves the context alone.
 */
export function FolderBinding({
  path,
  existing,
  inherited,
  inheritedContext,
  contexts,
  kube,
  onSave,
  onRemove,
  onClose,
}: FolderBindingProps) {
  const [context, setContext] = useState(existing?.context ?? "");
  const [namespace, setNamespace] = useState(existing?.namespace ?? "");
  const [guarded, setGuarded] = useState(existing?.protected ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  /** Runs a write, closing on success and reporting the registry's own message
   * on refusal — beside the field the user typed the bad value into. */
  const attempt = (write: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void write()
      .then(onClose)
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setBusy(false);
      });
  };

  return (
    <div className="settings__backdrop" role="presentation" onClick={onClose}>
      <div
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label={`Kubernetes binding for ${path}`}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 className="settings__title">
          <img className="icon" src={kubernetesMark} alt="" />
          Kubernetes binding for {path}
        </h2>

        <p className="settings__hint">
          Everything under this folder goes here. Leave a field inheriting to
          keep what the folder already resolves to: <strong>{inherited}</strong>.
        </p>

        <section className="settings__section" aria-label="Folder binding">
          <ContextField
            value={context}
            contexts={contexts}
            emptyLabel="Inherit from parent"
            label="context"
            onChange={setContext}
          />

          <NamespaceField
            context={namespaceSource(context, inheritedContext)}
            value={namespace}
            placeholder="Inherit from parent"
            label="namespace"
            kube={kube}
            onChange={setNamespace}
          />

          {/* No third state, and the description says so. Protection ratchets
              on: a folder can require confirmation its parent did not, and
              nothing here can take it away. */}
          <Protected
            checked={guarded}
            label="Protected"
            description="Applying, deleting or rolling back under this folder asks for the context name to be typed. Turning it off here cannot undo protection set further up."
            onChange={setGuarded}
          />
        </section>

        {error !== null && (
          <p className="settings__error" role="alert">
            {error}
          </p>
        )}

        <footer className="settings__actions">
          {existing !== null && (
            <button
              type="button"
              className="settings__remove"
              disabled={busy}
              onClick={() => {
                attempt(onRemove);
              }}
            >
              Remove override
            </button>
          )}
          <span className="settings__spacer" />
          <button type="button" className="settings__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="settings__save"
            disabled={busy}
            onClick={() => {
              attempt(() => onSave(context, namespace, guarded));
            }}
          >
            {busy ? "Saving" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export interface FolderDialogProps {
  readonly project: Project;
  /** The folder being bound, repository-relative. */
  readonly folder: string;
  /** What the folder resolves to today, for the dialog to show. */
  readonly inherited: string;
  /** The context it resolves to, for the namespace list to come from. */
  readonly inheritedContext: string;
  readonly contexts: readonly KubeContext[];
  readonly kube: Kube;
  /** Called with the project the registry answered with, so the strip and the
   * panel show the write without re-reading it. */
  onWritten: (project: Project) => void;
  onClose: () => void;
}

/**
 * The folder-binding dialog, wired to the registry.
 *
 * It is a component rather than a block inside `App` for the reason the seams
 * object exists: the workbench is at its branch ceiling, and every dialog
 * arrives with a pair of async writes and a conditional render. What it holds
 * is the wiring alone — which folder, which project, what to do with the answer
 * — and `FolderBinding` owns the form.
 */
export function FolderDialog({
  project,
  folder,
  inherited,
  inheritedContext,
  contexts,
  kube,
  onWritten,
  onClose,
}: FolderDialogProps) {
  return (
    <FolderBinding
      path={folder}
      existing={overrideAt(project, folder)}
      inherited={inherited}
      inheritedContext={inheritedContext}
      contexts={contexts}
      kube={kube}
      onSave={async (context, namespace, guarded) => {
        onWritten(await kube.bindFolder(project.name, folder, context, namespace, guarded));
      }}
      onRemove={async () => {
        onWritten(await kube.unbindFolder(project.name, folder));
      }}
      onClose={onClose}
    />
  );
}
