import { useCallback, useEffect, useState } from "react";
import type { Project, Registry } from "./projects";
import {
  directoryName,
  findProject,
  orderProjects,
  selectionAfterReload,
  selectionAfterRemove,
  settingsFor,
} from "./projects";

/**
 * A checkout the user has chosen but not yet registered.
 *
 * Naming happens before the project exists rather than after (#41): the tab
 * strip is the only place a project's identity is visible, and one that
 * appeared as "k8s" for the moment before a rename landed would be showing the
 * user exactly the thing the label is there to replace.
 */
export interface PendingProject {
  /** The directory the picker returned. */
  readonly path: string;
  /** What the name field starts out holding. */
  readonly suggested: string;
}

/**
 * The project registry as the workbench holds it: the list, which one is open,
 * the pending add, and every operation that writes projects.yaml.
 *
 * It lives here rather than in `App` for the reason the other hooks do — the
 * component's job is composition, and a strip that can rename, recolour and
 * reorder is four more pieces of state than a component at its line budget can
 * carry. Every write is optimistic-free: it goes to the registry and the list
 * is replaced with what the registry answers, so what is on screen is what is
 * on disk rather than what the UI hoped would land.
 */
export interface Projects {
  readonly list: Project[];
  readonly active: Project | null;
  readonly activeName: string | null;
  readonly error: string | null;
  readonly pending: PendingProject | null;
  readonly select: (name: string) => void;
  readonly reload: () => Promise<void>;
  /** Opens the OS picker; a chosen directory becomes `pending`. */
  readonly beginAdd: () => void;
  readonly cancelAdd: () => void;
  readonly commitAdd: (name: string) => void;
  readonly rename: (name: string, label: string) => void;
  readonly recolor: (name: string, color: string) => void;
  /** Takes the order a finished drag settled on, and persists it. */
  readonly move: (names: string[]) => void;
  readonly remove: (name: string) => void;
}

export function useProjects(registry: Registry): Projects {
  const [list, setList] = useState<Project[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingProject | null>(null);

  const reload = useCallback(async () => {
    try {
      const listed = await registry.list();
      setList(listed);
      setActiveName((active) => selectionAfterReload(listed, active));
      setError(null);
    } catch (failure: unknown) {
      // A registry that will not load is shown, never swallowed: an empty strip
      // would read as "you have no projects" when the truth is a broken
      // projects.yaml the user has to go fix.
      setError(describeError(failure));
    }
  }, [registry]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs a registry write, putting whatever it rejects with on screen. */
  const attempt = useCallback((write: () => Promise<void>) => {
    void (async () => {
      try {
        await write();
      } catch (failure: unknown) {
        setError(describeError(failure));
      }
    })();
  }, []);

  // Browse, then name, then register. The picker returns "" when the user
  // dismisses it, which ends the flow silently — a cancelled dialog is not a
  // failure and must not leave an error on screen.
  const beginAdd = useCallback(() => {
    setError(null);
    attempt(async () => {
      const chosen = await registry.choose();
      if (chosen !== "") {
        setPending({ path: chosen, suggested: directoryName(chosen) });
      }
    });
  }, [attempt, registry]);

  const cancelAdd = useCallback(() => {
    setPending(null);
  }, []);

  const commitAdd = useCallback(
    (name: string) => {
      if (pending === null) {
        return;
      }
      setPending(null);
      attempt(async () => {
        const added = await registry.add(pending.path, name.trim());
        await reload();
        setActiveName(added.name);
      });
    },
    [attempt, pending, registry, reload],
  );

  /**
   * Writes one project's settings and puts the answer back in the list.
   *
   * The patch is applied over the project's current settings rather than sent
   * alone, because Update replaces the mutable half whole — a rename that sent
   * only a name would unbind the cluster (see `settingsFor`).
   */
  const patch = useCallback(
    (name: string, changes: { displayName?: string; color?: string }) => {
      const project = findProject(list, name);
      if (project === null) {
        return;
      }
      attempt(async () => {
        const updated = await registry.update(name, settingsFor(project, changes));
        setList((current) =>
          current.map((p) => (p.name === updated.name ? updated : p)),
        );
      });
    },
    [attempt, list, registry],
  );

  const rename = useCallback(
    (name: string, label: string) => {
      patch(name, { displayName: label.trim() });
    },
    [patch],
  );

  const recolor = useCallback(
    (name: string, color: string) => {
      patch(name, { color });
    },
    [patch],
  );

  const move = useCallback(
    (names: string[]) => {
      const ordered = orderProjects(list, names);
      // The strip already shows this order — the drag reflowed it under the
      // pointer — so the list takes it now and the registry's answer replaces
      // it a moment later. Waiting for the round trip would snap the tab back
      // to its old place for as long as a file write takes.
      setList(ordered);
      void (async () => {
        try {
          setList(await registry.reorder(ordered.map((p) => p.name)));
        } catch (failure: unknown) {
          // This is the one write that puts something on screen before the
          // backend has agreed to it, so it is the one that has to be able to
          // take it back: a refused reorder leaves the strip showing an order
          // that is not in projects.yaml. Reloading first and reporting second
          // is deliberate — a successful reload clears the error.
          await reload();
          setError(describeError(failure));
        }
      })();
    },
    [list, registry, reload],
  );

  const remove = useCallback(
    (name: string) => {
      setActiveName((active) => selectionAfterRemove(list, name, active));
      attempt(async () => {
        await registry.remove(name);
        await reload();
      });
    },
    [attempt, list, registry, reload],
  );

  return {
    list,
    active: findProject(list, activeName),
    activeName,
    error,
    pending,
    select: setActiveName,
    reload,
    beginAdd,
    cancelAdd,
    commitAdd,
    rename,
    recolor,
    move,
    remove,
  };
}

/** Renders a rejected binding call as the sentence the strip shows. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the project registry is not reachable";
}
