import {
  AddProject,
  ChooseProjectDirectory,
  Projects,
  RemoveProject,
  UpdateProject,
} from "../../wailsjs/go/app/App";
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

/** A project's mutable half — the kube binding and helm defaults. */
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
  add: (path: string) => Promise<Project>;
  remove: (name: string) => Promise<void>;
  update: (name: string, settings: Settings) => Promise<Project>;
}

/** The registry backed by the Wails bindings. */
export const wailsRegistry: Registry = {
  list: () => Projects(),
  choose: () => ChooseProjectDirectory(),
  add: (path) => AddProject(path),
  remove: (name) => RemoveProject(name),
  update: (name, settings) => UpdateProject(name, settings),
};

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
