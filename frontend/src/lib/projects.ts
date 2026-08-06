import type { UniqueIdentifier } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  AddProject,
  ChooseProjectDirectory,
  Projects,
  RemoveProject,
  ReorderProjects,
  UpdateProject,
} from "../../wailsjs/go/app/App";
import { project as models } from "../../wailsjs/go/models";
import type { project } from "../../wailsjs/go/models";

/**
 * The project registry as the UI uses it (DESIGN.md §4).
 *
 * Projects are the app's organizing unit: one top-level tab each, terminals
 * rooted at the checkout, and — from #10 — a kube context bound per project.
 * Everything here is either a pure function over the list or a thin seam over
 * the Wails bindings, so the strip's behaviour is testable without a backend.
 */

/**
 * One registered repository, aliased from the generated binding rather than
 * restated: a change to the Go struct fails type-checking here instead of
 * silently disagreeing with it.
 */
export type Project = project.Project;

/** A project's mutable half — its label, its tab colour and its bindings. */
export type Settings = project.Settings;

/**
 * The registry operations the UI performs. It is an interface so tests can
 * drive the strip without a Wails runtime, in the same shape `AppProps` already
 * uses for the build info and the stream endpoint.
 */
export interface Registry {
  list: () => Promise<Project[]>;
  /** Opens the OS directory picker; resolves to "" if the user cancels. */
  choose: () => Promise<string>;
  add: (path: string, name: string) => Promise<Project>;
  remove: (name: string) => Promise<void>;
  update: (name: string, settings: Settings) => Promise<Project>;
  /** Rewrites the stored order, and answers with the registry as it stands. */
  reorder: (names: string[]) => Promise<Project[]>;
}

/** The registry backed by the Wails bindings. */
export const wailsRegistry: Registry = {
  list: () => Projects(),
  choose: () => ChooseProjectDirectory(),
  add: (path, name) => AddProject(path, name),
  remove: (name) => RemoveProject(name),
  update: (name, settings) => UpdateProject(name, settings),
  reorder: (names) => ReorderProjects(names),
};

/**
 * The tab colours a project can carry (#41), as names rather than values.
 *
 * The registry stores the name and this list is what resolves it, which is why
 * a colour never reaches the DOM as a value: the tab carries `data-color` and
 * the stylesheet holds the palette, so a projects.yaml edited by hand can no
 * more inject a colour than it can inject a rule.
 */
export const PROJECT_COLORS = [
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "cyan",
] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

/** The palette entry a stored colour names, or null when this build has none. */
export function projectColor(stored: string | undefined): ProjectColor | null {
  return PROJECT_COLORS.find((color) => color === stored) ?? null;
}

/**
 * What a project's tab says.
 *
 * `name` is the registry key — derived from the directory, and almost always
 * "k8s" for a manifest repository, which is the whole reason a label exists.
 * The fallback is what every registry written before #41 has, and what a
 * project added without typing a name keeps.
 *
 * The `?? ""` is not defensive noise: the generated model copies keys straight
 * out of the bridge payload, so a record produced without the field is
 * `undefined` here rather than "".
 */
export function projectLabel(project: Project): string {
  const label = (project.displayName ?? "").trim();
  return label === "" ? project.name : label;
}

/**
 * The settings to send when changing a project's label or colour.
 *
 * `Update` replaces the whole mutable half, so the kube binding and the helm
 * defaults have to be carried through a rename. Sending only what changed would
 * unbind the cluster of any project the user renamed — which is the failure
 * DESIGN.md §4 is most emphatic about not having.
 */
export function settingsFor(
  project: Project,
  patch: { displayName?: string; color?: string },
): Settings {
  return models.Settings.createFrom({
    displayName: patch.displayName ?? project.displayName,
    color: patch.color ?? project.color,
    kube: project.kube,
    helm: project.helm,
  });
}

/**
 * The name to prefill the add-project field with: the chosen directory's own
 * name, which is the best guess available and the one the user is most likely
 * to replace.
 *
 * Both separators are split on because the path comes from the OS picker and
 * m6t runs on Windows too.
 */
export function directoryName(path: string): string {
  const segments = path.split(/[/\\]+/).filter((segment) => segment !== "");
  return segments.length === 0 ? path : segments[segments.length - 1];
}

/**
 * The order a finished tab drag settled on, or null when it changed nothing.
 *
 * This is the whole of what the strip does with a drag: dnd-kit reports which
 * tab was lifted and which it was dropped over, `arrayMove` puts it there, and
 * the result is what gets persisted. A drop outside the strip has no `over` and
 * is not a reorder — nor is a tab dropped back on itself, which is what every
 * click that drifted past the threshold looks like.
 */
export function orderAfterDrag(
  names: readonly string[],
  active: UniqueIdentifier,
  over: UniqueIdentifier | undefined,
): string[] | null {
  if (over === undefined || active === over) {
    return null;
  }
  const from = names.indexOf(String(active));
  const to = names.indexOf(String(over));
  if (from < 0 || to < 0) {
    return null;
  }
  return arrayMove([...names], from, to);
}

/**
 * The projects in the order `names` gives.
 *
 * Anything the order does not mention keeps its place at the end rather than
 * disappearing: the names come from a drag that started against a list which
 * may since have gained a project — projects.yaml is editable by hand while
 * m6t runs (DESIGN.md §4) — and a strip that dropped the tab it had not heard
 * of would be losing a project to a gesture. A name that no longer matches a
 * project is skipped for the same reason in reverse.
 */
export function orderProjects(
  projects: readonly Project[],
  names: readonly string[],
): Project[] {
  const named = names
    .map((name) => projects.find((p) => p.name === name))
    .filter((project): project is Project => project !== undefined);
  const rest = projects.filter((project) => !named.includes(project));
  return [...named, ...rest];
}

/**
 * The project to select after `name` is removed.
 *
 * The same rule the terminal strip uses: removing an inactive project must not
 * move the selection, and removing the active one selects its right-hand
 * neighbour because that is where the eye already is.
 */
export function selectionAfterRemove(
  projects: readonly Project[],
  name: string,
  active: string | null,
): string | null {
  if (active !== name) {
    return active;
  }
  const index = projects.findIndex((p) => p.name === name);
  if (index < 0) {
    return active;
  }
  const remaining = projects.filter((p) => p.name !== name);
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(index, remaining.length - 1)].name;
}

/**
 * The project a name refers to, or null.
 *
 * Returning null rather than throwing is deliberate: the selection and the list
 * are separate pieces of state, and a render that happens between a removal and
 * the selection catching up must show an empty workbench rather than crash.
 */
export function findProject(
  projects: readonly Project[],
  name: string | null,
): Project | null {
  if (name === null) {
    return null;
  }
  return projects.find((p) => p.name === name) ?? null;
}

/**
 * The selection to hold after the list is reloaded.
 *
 * A reload must not move the user off the project they are working in, but the
 * project they were in may be gone — removed here, or removed from
 * projects.yaml by hand while the app was running, which DESIGN.md §4 allows.
 */
export function selectionAfterReload(
  projects: readonly Project[],
  active: string | null,
): string | null {
  if (active !== null && projects.some((p) => p.name === active)) {
    return active;
  }
  return projects.length > 0 ? projects[0].name : null;
}
