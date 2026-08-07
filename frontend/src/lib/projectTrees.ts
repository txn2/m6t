import type { TreeState } from "./tree";
import { initialTree } from "./tree";

/**
 * The workbench's trees, one per project (#59).
 *
 * It is the file tree's answer to the shape `editorTabs.ts` and `tabs.ts`
 * already give the other two strips: state for every project, filtered down to
 * the active one for display. The three differ in what forced the shape — a
 * shell and an unsaved buffer cannot be rebuilt, a listing merely costs a round
 * trip — and in the key, which is a root path here rather than a project name;
 * see `ProjectTrees`.
 *
 * Its own module rather than a section of `tree.ts` because the two answer
 * different questions: that one is the shape of a tree, this one is which tree
 * is being looked at.
 */

/**
 * Every project's tree, keyed by the project's root path (#59).
 *
 * Keyed by root rather than by project name because a root is what a listing
 * is relative to: `manifests/prod` means one directory under one checkout and
 * another under a second, and a key that did not distinguish them would let
 * one project's rows appear under the other. The registry refuses to hold the
 * same path twice, so a root names exactly one project.
 */
export type ProjectTrees = Readonly<Record<string, TreeState>>;

/**
 * One project's tree, or a blank one for a project this map has never held.
 *
 * The blank carries the changed-files filter the rest of the map is showing,
 * which is what keeps that one field window-wide (`withTree`).
 */
export function treeFor(trees: ProjectTrees, root: string | null): TreeState {
  const stored = root === null ? undefined : trees[root];
  return stored ?? { ...initialTree(), changedOnly: changedOnlyOf(trees) };
}

/** Whether the changed-files filter is on, read off whichever entry comes
 * first — every entry holds the same answer, by `withTree`'s construction. */
function changedOnlyOf(trees: ProjectTrees): boolean {
  return Object.values(trees)[0]?.changedOnly ?? false;
}

/**
 * Records one project's tree.
 *
 * `changedOnly` moves for every project at once, unlike everything else here.
 * It is a property of how the user is working rather than of the project they
 * are looking at — the same as the sidebar's width, and the reason the session
 * stores it beside the window settings rather than in a project's record. It
 * lives inside `TreeState` because `reveal` has to be able to clear it, so
 * keeping it window-wide is this function's job rather than the state's.
 */
export function withTree(trees: ProjectTrees, root: string, next: TreeState): ProjectTrees {
  const stored = { ...trees, [root]: next };
  if (next.changedOnly === changedOnlyOf(trees)) {
    return stored;
  }
  return Object.fromEntries(
    Object.entries(stored).map(([key, state]) => [
      key,
      state.changedOnly === next.changedOnly ? state : { ...state, changedOnly: next.changedOnly },
    ]),
  );
}

/** Drops one project's tree — what a project leaving the registry takes with
 * it. Without this the map would hold an entry nothing can reach for the life
 * of the app. */
export function withoutTree(trees: ProjectTrees, root: string): ProjectTrees {
  if (!(root in trees)) {
    return trees;
  }
  const { [root]: _dropped, ...rest } = trees;
  return rest;
}
