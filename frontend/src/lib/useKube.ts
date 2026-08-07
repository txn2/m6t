import { useCallback, useEffect, useState } from "react";
import type { Binding, CheckResult, Kube, KubeContext, Tool } from "./kube";
import { UNBOUND } from "./kube";

/** What the panel and the status bar read. */
export interface KubeController {
  /** The binding for the path currently selected, resolved by the backend. */
  readonly binding: Binding;
  /** The contexts the user's kubeconfig offers, for the settings form. */
  readonly contexts: readonly KubeContext[];
  /** Where the kubeconfig was read from, for the empty state to name. */
  readonly sources: readonly string[];
  /** Which external binaries are installed (DESIGN.md §2). */
  readonly tools: readonly Tool[];
  /** The last smoke-check result, or null before one has run. */
  readonly result: CheckResult | null;
  /** A sentence describing the last failure, or null. */
  readonly error: string | null;
  /** True while a smoke check is in flight. */
  readonly checking: boolean;
  /** Runs the smoke action against the current selection. */
  check: () => void;
  /** Re-reads the kubeconfig and the tool list. */
  refresh: () => void;
}

export interface KubeSelection {
  /** The active project's registry name, or null when there is none. */
  readonly project: string | null;
  /**
   * The repository-relative path the panel is describing — a directory, or ""
   * for the project root. It is a directory rather than a file because a scope
   * binds a subtree; `scopeOf` is what turns a selected file into one.
   */
  readonly rel: string;
}

/**
 * The cluster binding for whatever is selected, kept current as the selection
 * moves (DESIGN.md §4, §5).
 *
 * Every binding shown comes from the backend. That is the point rather than an
 * implementation detail: `projects.yaml` is editable by hand while m6t is
 * running, so a binding the frontend worked out from a project record it
 * fetched at launch could name the cluster the user unbound an hour ago. The
 * round trip is one call against a small file, and it buys the guarantee that
 * the context on screen is the context a kubectl call would use.
 *
 * A failed resolution falls back to UNBOUND rather than to the last good
 * answer. Showing a stale binding while the current one cannot be read would be
 * the most dangerous thing this hook could do — the panel would name a cluster
 * that the apply button no longer targets.
 */
export function useKube(selection: KubeSelection, kube: Kube): KubeController {
  const { project, rel } = selection;

  const [binding, setBinding] = useState<Binding>(UNBOUND);
  const [contexts, setContexts] = useState<readonly KubeContext[]>([]);
  const [sources, setSources] = useState<readonly string[]>([]);
  const [tools, setTools] = useState<readonly Tool[]>([]);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (project === null) {
      setBinding(UNBOUND);
      return;
    }
    let current = true;
    void (async () => {
      try {
        const next = await kube.binding(project, rel);
        if (current) {
          setBinding(next);
        }
      } catch {
        // Deliberately silent, and deliberately UNBOUND. A project whose
        // binding cannot be read is one every kube control must be disabled
        // for, which is exactly what UNBOUND produces; an error banner would
        // add noise to a state the panel already describes in words.
        if (current) {
          setBinding(UNBOUND);
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [project, rel, kube, generation]);

  // The selection moved, so the previous check's verdict is about somewhere
  // else. Keeping it would leave "the cluster answered" sitting above a
  // different cluster's name.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [project, rel]);

  useEffect(() => {
    let current = true;
    void (async () => {
      const [config, detected] = await Promise.allSettled([kube.contexts(), kube.tools()]);
      if (!current) {
        return;
      }
      if (config.status === "fulfilled") {
        setContexts(config.value.contexts ?? []);
        setSources(config.value.sources ?? []);
      } else {
        setContexts([]);
        setError(describe(config.reason));
      }
      setTools(detected.status === "fulfilled" ? detected.value : []);
    })();
    return () => {
      current = false;
    };
  }, [kube, generation]);

  const check = useCallback(() => {
    if (project === null) {
      return;
    }
    setChecking(true);
    setError(null);
    void (async () => {
      try {
        setResult(await kube.check(project, rel));
      } catch (failure: unknown) {
        setResult(null);
        setError(describe(failure));
      } finally {
        setChecking(false);
      }
    })();
  }, [project, rel, kube]);

  const refresh = useCallback(() => {
    setGeneration((n) => n + 1);
  }, []);

  return { binding, contexts, sources, tools, result, error, checking, check, refresh };
}

/** Renders a rejected binding call as a sentence a panel can show. */
function describe(failure: unknown): string {
  if (failure instanceof Error) {
    return failure.message;
  }
  return typeof failure === "string" ? failure : "the backend is not reachable";
}
