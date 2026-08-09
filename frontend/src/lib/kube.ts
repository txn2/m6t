import {
  BindFolder,
  KubeApply,
  KubeBinding,
  KubeCheck,
  KubeContexts,
  KubeDelete,
  KubeDeletePreview,
  KubeDiff,
  KubeNamespaces,
  KubeValidate,
  Tools,
  UnbindFolder,
} from "../../wailsjs/go/app/App";
import { project as models } from "../../wailsjs/go/models";
import type { kubeconfig, kubeexec, project, tools } from "../../wailsjs/go/models";
import type { Project, Settings } from "./projects";

/**
 * The cluster binding as the UI uses it (DESIGN.md §4, §5).
 *
 * The one rule this module exists to keep: the frontend never works out which
 * cluster a path is aimed at. `Kube.Resolve` in internal/project owns that, and
 * everything here either asks the backend for the answer or renders one it was
 * given. A second copy of the resolution rules living in TypeScript would be
 * two answers to "which cluster does this file go to", and the whole point of
 * the binding is that there is exactly one.
 */

/** The shapes, aliased from the generated bindings rather than restated. */
export type Binding = project.Binding;
export type Scope = project.Scope;
export type KubeContext = kubeconfig.Context;
export type KubeConfig = kubeconfig.Config;
export type CheckResult = kubeexec.Result;
export type Tool = tools.Tool;

/**
 * The kube operations the UI performs. An interface so the panel and the
 * settings dialog are testable without a Wails runtime or a cluster, in the
 * shape `Registry` and `SessionStore` already use.
 */
export interface Kube {
  /** The contexts the user's kubeconfig offers, for the binding form. */
  contexts: () => Promise<KubeConfig>;
  /** What a repository-relative path resolves to; "" is the project itself. */
  binding: (name: string, rel: string) => Promise<Binding>;
  /** The namespaces a context offers, for a binding form to complete from.
   * Rejects for a user whose RBAC cannot list them, which is ordinary — the
   * field stays typeable. */
  namespaces: (context: string) => Promise<string[]>;
  /** The smoke action: does this binding actually reach a cluster? */
  check: (name: string, rel: string) => Promise<CheckResult>;
  /** Points one folder at a context and namespace, replacing any override on
   * it. Either half may be empty, meaning inherit. */
  bindFolder: (
    name: string,
    path: string,
    context: string,
    namespace: string,
    guarded: boolean,
  ) => Promise<Project>;
  /** Removes a folder's override, returning it to what it inherits. */
  unbindFolder: (name: string, path: string) => Promise<Project>;
  /** Which external binaries are installed, and at what version. */
  tools: () => Promise<Tool[]>;

  // The diff → apply pipeline (#11, DESIGN.md §6.1). Every one of these takes
  // the repository-relative path it acts on and nothing else about the target:
  // which cluster it reaches is the backend's answer, resolved from the
  // registry at the moment of the call. See internal/app/pipeline.go.

  /** Step 1: `kubectl apply --dry-run=server`. A non-zero exit blocks. */
  validate: (name: string, target: string) => Promise<CheckResult>;
  /** Step 2: `kubectl diff`. Exit 0 is "no changes", 1 is "changes". */
  diff: (name: string, target: string) => Promise<CheckResult>;
  /**
   * Step 4: the apply itself. `typed` is the context name from the confirm
   * dialog, and the backend refuses a protected binding without it — passing
   * "" for an unprotected one is the ordinary case, not a bypass.
   */
  apply: (name: string, target: string, typed: string) => Promise<CheckResult>;
  /** The delete's preview: what would be removed, removing nothing. */
  deletePreview: (name: string, target: string) => Promise<CheckResult>;
  /** The delete itself, under the same confirmation an apply needs. */
  remove: (name: string, target: string, typed: string) => Promise<CheckResult>;
}

/** The kube seam backed by the Wails bindings. */
export const wailsKube: Kube = {
  contexts: () => KubeContexts(),
  binding: (name, rel) => KubeBinding(name, rel),
  namespaces: (context) => KubeNamespaces(context),
  check: (name, rel) => KubeCheck(name, rel),
  bindFolder: (name, path, context, namespace, guarded) =>
    BindFolder(name, path, context, namespace, guarded),
  unbindFolder: (name, path) => UnbindFolder(name, path),
  tools: () => Tools(),
  validate: (name, target) => KubeValidate(name, target),
  diff: (name, target) => KubeDiff(name, target),
  apply: (name, target, typed) => KubeApply(name, target, typed),
  deletePreview: (name, target) => KubeDeletePreview(name, target),
  // `remove` rather than `delete`, which is a reserved word: the seam is an
  // object literal and a property named `delete` would read as the operator at
  // every call site.
  remove: (name, target, typed) => KubeDelete(name, target, typed),
};

/** A binding with nothing in it: what an unbound project shows. */
export const UNBOUND: Binding = {
  context: "",
  namespace: "",
  protected: false,
  scope: "",
};

/**
 * Whether a binding can target a cluster at all — the frontend's copy of
 * `project.Binding.Bound`, and the condition every kube control is disabled on.
 *
 * Both halves are required for the reason the Go side gives: kubectl with no
 * `--namespace` falls back to the context's own default, so a half-bound
 * project would still reach a cluster, just not a named one.
 */
export function isBound(binding: Binding): boolean {
  return binding.context !== "" && binding.namespace !== "";
}

/**
 * Whether a project has any Kubernetes binding at all — a default, or a folder
 * override somewhere in its tree.
 *
 * It is what decides whether the tree offers the pipeline on a row (#11), and
 * it is deliberately NOT a resolution. `isBound` above answers about one
 * binding the backend resolved; this answers "has the user pointed this
 * repository at a cluster anywhere", which is the question an affordance
 * should ask. Using the selection's resolved binding for it would hide Apply on
 * a bound `prod/` folder whenever the file on screen happened to be somewhere
 * unbound — and nothing here targets anything, so the rule against the frontend
 * working out which cluster a path is aimed at is not in play: what a run
 * actually reaches is resolved by the backend on the call itself.
 */
export function hasBinding(project: Project | null): boolean {
  if (project === null) {
    return false;
  }
  return project.kube.context !== "" || (project.kube.scopes ?? []).length > 0;
}

/** A binding as one line: "prod-us-west / api", or the unbound prompt. */
export function bindingSummary(binding: Binding): string {
  if (!isBound(binding)) {
    return "not bound";
  }
  return `${binding.context} / ${binding.namespace}`;
}

/**
 * The settings to send when changing a project's kube binding.
 *
 * The whole mutable half goes across on every update (see `settingsFor`), so
 * the label, colour and helm defaults are carried through a rebind. Sending
 * only the binding would drop the tab's name — the mirror image of the failure
 * `settingsFor` exists to prevent.
 */
export function settingsWithKube(project: Project, kube: project.Kube): Settings {
  return models.Settings.createFrom({
    displayName: project.displayName,
    color: project.color,
    kube,
    helm: project.helm,
  });
}

/**
 * A project's stored binding with one field replaced.
 *
 * `scopes` is normalized to an array on the way out because Go marshals an
 * empty slice as `null`: a project that has never had a scope arrives here with
 * `scopes: null`, and the form has to be able to push a row onto it.
 */
export function withKube(
  project: Project,
  patch: Partial<
    Pick<project.Kube, "context" | "namespace" | "protected" | "scopes">
  >,
): project.Kube {
  const current = project.kube;
  return models.Kube.createFrom({
    context: patch.context ?? current.context,
    namespace: patch.namespace ?? current.namespace,
    protected: patch.protected ?? current.protected,
    scopes: patch.scopes ?? current.scopes ?? [],
  });
}

/**
 * The directory a selected path belongs to, in the repository-relative,
 * slash-separated form a scope is written in.
 *
 * A file resolves as its directory because that is what the user bound: they
 * pointed a folder at a cluster, and `prod/api/deploy.yaml` inheriting from
 * `prod/api` is the whole mechanism. Passing the file path itself would work
 * too — `Resolve` matches whole segments either way — but the panel shows the
 * scope that applied, and "prod/api" is what a user can find in their settings.
 */
export function scopeOf(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? "" : normalized.slice(0, cut);
}

/** The override on exactly this folder, or null when it only inherits one. */
export function overrideAt(project: Project, path: string): Scope | null {
  return (project.kube.scopes ?? []).find((scope) => scope.path === path) ?? null;
}

/** The set of folders carrying an override, for the tree to mark. */
export function overriddenPaths(project: Project | null): ReadonlySet<string> {
  if (project === null) {
    return new Set();
  }
  return new Set((project.kube.scopes ?? []).map((scope) => scope.path));
}

/** A tool that is installed and answered its version probe. */
export function isUsable(tool: Tool): boolean {
  return tool.found && tool.problem === "";
}

/**
 * What the UI says about a tool that is not usable, or "" when it is.
 *
 * The sentence is the tool's own — a missing binary reports which one and where
 * it was looked for, and a failed probe carries the tool's stderr verbatim
 * (CLAUDE.md: tool errors are not translated into prose). What is added here is
 * only the consequence, which the backend has no business knowing.
 */
export function toolProblem(tool: Tool): string {
  if (isUsable(tool)) {
    return "";
  }
  const consequence = DEGRADED[tool.name] ?? "";
  return consequence === "" ? tool.problem : `${tool.problem}. ${consequence}.`;
}

/** What stops working when a given tool is unavailable (DESIGN.md §2). */
const DEGRADED: Record<string, string> = {
  git: "Branch, diff and history are unavailable",
  kubectl: "Every cluster action is disabled",
  helm: "Helm features are disabled",
};
