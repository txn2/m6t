import { useEffect, useState } from "react";
import type { Binding, CheckResult, Kube, KubeContext, Scope, Tool } from "../lib/kube";
import { isBound, isUsable, overrideAt, toolProblem } from "../lib/kube";
import type { Project } from "../lib/projects";
import { projectLabel } from "../lib/projects";
import type { RunEntry } from "../lib/pipeline";
import type { KubeController } from "../lib/useKube";
import type { HealthController } from "../lib/useHealth";
import { ClusterHealth } from "./ClusterHealth";
import { RunLog } from "./RunLog";
import { ContextField, NamespaceField } from "./NamespaceField";
import { UiIcon } from "./Icon";
/** The Kubernetes wheel, vendored with the file-type marks (see Icon.tsx). */
import kubernetesMark from "../icons/material/kubernetes.svg";

export interface ProjectPanelProps {
  readonly project: Project;
  /** The binding and tool state for the current selection (#10). */
  readonly kube: KubeController;
  /** The seam, for the namespace list to come from the cluster. */
  readonly seam: Kube;
  /** The folder the current selection sits in; "" is the project root. */
  readonly scope: string;
  /** Writes the project default. Rejects with the registry's own message. */
  onDefault: (context: string, namespace: string, guarded: boolean) => Promise<void>;
  /** Writes the selected folder's override. Rejects the same way. */
  onOverride: (context: string, namespace: string, guarded: boolean) => Promise<void>;
  /** What this project's pipeline has done this session (#11). */
  readonly runs: readonly RunEntry[];
  /** Live cluster health for the current selection (#12). */
  readonly health: HealthController;
}

/**
 * The project panel (DESIGN.md §5): everything about the open project that is
 * not a file, in sections that go from what the project IS to what the thing on
 * screen is aimed at.
 *
 * Attributes first, because a panel that opens with a cluster name and never
 * says which project it belongs to reads the same for every tab. Kubernetes
 * second, holding the one binding that covers the whole checkout. Then the
 * selection, which is the first part that changes as the user moves around —
 * everything above it is stable, and a section that redrew at the top would
 * push those two down the panel every time.
 *
 * Nothing here has a save button. Every control writes when it changes, and
 * what it shows afterwards is what the registry answered with rather than what
 * was picked in it — which is also what makes a refused write visible instead
 * of sitting pending behind a button nobody pressed.
 *
 * Live status sits under the selection because it answers about the same
 * target that section names — where does this go, and what is there now — and
 * above the run log because the log is history and the status is the present.
 * The log is last for the reason it was always last: it is the only part of
 * this panel that grows, so anything below it would be pushed down every time
 * a run finished.
 */
export function ProjectPanel({
  project,
  kube,
  seam,
  scope,
  onDefault,
  onOverride,
  runs,
  health,
}: ProjectPanelProps) {
  return (
    <div className="panel" data-protected={kube.binding.protected || undefined}>
      <h2 className="panel__title">Project</h2>

      <Attributes project={project} />

      <KubeSection project={project} kube={kube} seam={seam} onDefault={onDefault} />

      <Selection
        project={project}
        binding={kube.binding}
        override={overrideAt(project, scope)}
        contexts={kube.contexts}
        seam={seam}
        scope={scope}
        onOverride={onOverride}
      />

      <ClusterHealth health={health} />

      {/* Last, because it is a history of what has been done to the thing the
          sections above name — and because it is the only part of this panel
          that grows, so anything that redrew above it would push the stable
          sections down (#11). */}
      <RunLog entries={runs} />

      <ToolStates tools={kube.tools} onRefresh={kube.refresh} />
    </div>
  );
}

/** What the project is: the name on its tab, and where its checkout lives. */
function Attributes({ project }: { readonly project: Project }) {
  return (
    <section className="panel__section" aria-label="Project attributes">
      <h3 className="panel__section-title">Project attributes</h3>

      <Fact label="name" value={projectLabel(project)} />
      {/* The home-abbreviated form the registry file holds. A panel this narrow
          cannot show an absolute path without wrapping it twice, and "~" is
          what the user calls that directory anyway. */}
      <Fact label="directory" value={project.shortPath} title={project.path} />
    </section>
  );
}

function Fact({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}) {
  return (
    <p className="panel__fact">
      <span className="panel__fact-label">{label}</span>
      <span className="panel__fact-value" title={title}>
        {value}
      </span>
    </p>
  );
}

interface KubeSectionProps {
  readonly project: Project;
  readonly kube: KubeController;
  readonly seam: Kube;
  onDefault: (context: string, namespace: string, guarded: boolean) => Promise<void>;
}

/**
 * The project default: the binding everything in the checkout inherits.
 *
 * The fields are driven by what is stored, not by a local draft. That is what
 * makes an implicit save honest — a write the registry refuses leaves the
 * control showing the value that is actually in force, with the reason under
 * it, rather than the value that was picked and quietly dropped.
 */
function KubeSection({ project, kube, seam, onDefault }: KubeSectionProps) {
  const stored = project.kube;
  const { error, write } = useWrite(project.name);

  return (
    <section className="panel__section" aria-label="Kubernetes">
      <h3 className="panel__section-title">
        <img className="icon" src={kubernetesMark} alt="" />
        Kubernetes
      </h3>

      {kube.contexts.length === 0 ? (
        <p className="panel__empty">
          No contexts found in{" "}
          {kube.sources.length === 0 ? "your kubeconfig" : kube.sources.join(", ")}.
        </p>
      ) : (
        <ContextField
          value={stored.context}
          contexts={kube.contexts}
          emptyLabel="Not bound"
          label="project context"
          onChange={(next) => {
            // The context's own default namespace, taken only when there is no
            // namespace to lose: picking a context and then having to pick a
            // namespace the kubeconfig already named is a second decision for
            // no reason.
            const suggested = kube.contexts.find((entry) => entry.name === next)?.namespace ?? "";
            const namespace = stored.namespace === "" ? suggested : stored.namespace;
            write(() => onDefault(next, namespace, stored.protected));
          }}
        />
      )}

      <NamespaceField
        context={stored.context}
        value={stored.namespace}
        placeholder="Not set"
        label="project namespace"
        kube={seam}
        onChange={(next) => {
          write(() => onDefault(stored.context, next, stored.protected));
        }}
      />

      <Protected
        checked={stored.protected}
        label="Protected"
        description="Applying, deleting or rolling back anywhere in this project asks for the context name to be typed."
        onChange={(next) => {
          write(() => onDefault(stored.context, stored.namespace, next));
        }}
      />

      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}

      {isBound(kube.binding) && <Check kube={kube} />}
    </section>
  );
}

/**
 * A write, and whatever it came back with.
 *
 * The key resets the message: an error about the project — or the folder — that
 * was on screen a moment ago has no business sitting under the controls of the
 * one that is.
 */
function useWrite(key: string): {
  readonly error: string | null;
  readonly write: (run: () => Promise<void>) => void;
} {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [key]);

  const write = (run: () => Promise<void>) => {
    setError(null);
    void run().catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  return { error, write };
}

/**
 * A protected toggle with its consequence underneath it.
 *
 * The sentence sits below the label rather than trailing it, because what it
 * describes is the most consequential switch in the app and a caption running
 * off the side of a checkbox is a caption nobody reads.
 */
export function Protected({
  checked,
  label,
  description,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly description: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="panel__toggle">
      <label className="panel__toggle-label">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <span>{label}</span>
      </label>
      <p className="panel__toggle-note">{description}</p>
    </div>
  );
}

interface SelectionProps {
  readonly project: Project;
  readonly binding: Binding;
  /** The override on the selected folder itself, or null when it has none. */
  readonly override: Scope | null;
  readonly contexts: readonly KubeContext[];
  readonly seam: Kube;
  readonly scope: string;
  onOverride: (context: string, namespace: string, guarded: boolean) => Promise<void>;
}

/**
 * Where the thing on screen actually goes, and the controls that change it.
 *
 * The two fields show the *resolved* target rather than the folder's own
 * override, because the question this section answers is "where does this go",
 * not "what did I put here". Changing one writes an override onto the selected
 * folder and leaves the other field's own value alone, so setting a namespace
 * on a folder that inherits its context keeps the context inheriting.
 *
 * A field pointing somewhere other than the project default is marked, in the
 * colour the tree marks a bound folder with. That mark is the whole safety
 * argument for editing here rather than only in the folder dialog: a control
 * that quietly sent one directory to a different cluster from the rest of the
 * project would be the most dangerous thing in the window.
 */
function Selection({
  project,
  binding,
  override,
  contexts,
  seam,
  scope,
  onOverride,
}: SelectionProps) {
  const { error, write } = useWrite(scope);
  const own = override ?? { context: "", namespace: "", protected: false };

  return (
    <section className="panel__section" aria-label="Selection">
      <h3 className="panel__section-title">Selection</h3>

      <Fact label="folder" value={scope === "" ? "project root" : scope} />

      {scope === "" ? (
        // The root's binding IS the project default, so the controls above are
        // already its editor. A second pair here would be two ways to write one
        // value, and whichever lost a race would look like a bug.
        <p className="panel__hint">
          The project root takes the default above. Open a file inside a folder
          to bind that folder.
        </p>
      ) : (
        <>
          <Field diverged={binding.context !== project.kube.context}>
            <ContextField
              value={binding.context}
              contexts={contexts}
              emptyLabel="Inherit from parent"
              label="selection context"
              onChange={(next) => {
                write(() => onOverride(next, own.namespace, own.protected));
              }}
            />
          </Field>

          <Field diverged={binding.namespace !== project.kube.namespace}>
            <NamespaceField
              context={binding.context}
              value={binding.namespace}
              placeholder="Inherit from parent"
              label="selection namespace"
              kube={seam}
              onChange={(next) => {
                write(() => onOverride(own.context, next, own.protected));
              }}
            />
          </Field>

          <Fact label="from" value={origin(binding)} />
        </>
      )}

      {binding.protected && (
        <p className="panel__protected">
          <UiIcon name="lock" />
          Protected. Applying here asks for the context name to be typed.
        </p>
      )}

      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** One selection field, marked when it points somewhere other than the project
 * default. */
function Field({
  diverged,
  children,
}: {
  readonly diverged: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="panel__field" data-diverged={diverged || undefined}>
      {children}
    </div>
  );
}

/**
 * Which rule produced this binding.
 *
 * An unbound selection says so rather than crediting "the project default",
 * which is technically where it fell through to and tells the user nothing: a
 * project laid out as per-folder bindings with no default at all is a normal
 * project, and the answer they need is that no rule covers this folder yet.
 */
function origin(binding: Binding): string {
  if (!isBound(binding)) {
    return "no rule covers this folder";
  }
  return binding.scope === "" ? "the project default" : `the ${binding.scope} override`;
}

/** The smoke action and its verdict. */
function Check({ kube }: { readonly kube: KubeController }) {
  return (
    <>
      <div className="panel__actions">
        <button
          type="button"
          className="panel__action"
          disabled={kube.checking}
          onClick={kube.check}
        >
          {kube.checking ? "Checking" : "Check connection"}
        </button>
      </div>

      {kube.error !== null && (
        <p className="panel__error" role="alert">
          {kube.error}
        </p>
      )}
      {kube.result !== null && <CheckVerdict result={kube.result} />}
    </>
  );
}

/**
 * One check's outcome.
 *
 * A non-zero exit is kubectl's own message, shown verbatim (CLAUDE.md): the
 * user knows how to read "Unable to connect to the server" and a translation
 * would only lose the detail that makes it actionable. The argv is shown
 * alongside because DESIGN.md §1 promises that everything m6t does is something
 * the user could have typed themselves; this is where that is made good on.
 */
function CheckVerdict({ result }: { readonly result: CheckResult }) {
  const ok = result.exitCode === 0;
  return (
    <div className="panel__verdict" data-ok={ok ? "true" : "false"}>
      <p>{ok ? "The cluster answered." : `kubectl exited ${String(result.exitCode)}`}</p>
      {!ok && result.stderr !== "" && <pre className="panel__stderr">{result.stderr}</pre>}
      <details className="panel__argv">
        <summary>command</summary>
        <pre>{(result.argv ?? []).join(" ")}</pre>
      </details>
    </div>
  );
}

/**
 * The degraded states for the binaries m6t drives (DESIGN.md §2).
 *
 * Only the unusable ones are listed. A panel that named all three every time
 * would be three lines of "git 2.43.0, kubectl v1.36.2, helm v3.14.0" occupying
 * the space the cluster is supposed to be in: the versions belong in an about
 * box, and what belongs here is the sentence explaining why a feature is off.
 */
function ToolStates({
  tools,
  onRefresh,
}: {
  readonly tools: readonly Tool[];
  onRefresh: () => void;
}) {
  const degraded = tools.filter((tool) => !isUsable(tool));
  if (degraded.length === 0) {
    return null;
  }

  return (
    <section className="panel__tools" aria-label="Tool availability">
      <ul>
        {degraded.map((tool) => (
          <li key={tool.name} className="panel__tool">
            {toolProblem(tool)}
          </li>
        ))}
      </ul>
      <button type="button" className="panel__recheck" onClick={onRefresh}>
        Look again
      </button>
    </section>
  );
}
