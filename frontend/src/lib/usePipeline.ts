import { useCallback, useEffect, useRef, useState } from "react";
import type { Binding, CheckResult, Kube } from "./kube";
import { UNBOUND } from "./kube";
import type { PipelineAction, PipelinePhase, RunEntry } from "./pipeline";
import { blocks, logged } from "./pipeline";

/**
 * The diff → apply pipeline in progress (DESIGN.md §6.1, issue #11).
 *
 * One run at a time, because the dialog is modal and because two applies aimed
 * at one cluster from one window is not a thing to make possible by accident.
 * The stages are sequenced here rather than in the backend for the reason
 * `internal/app/pipeline.go` gives: step 3 is a person answering a question, so
 * the thing that waits for them is the thing that owns the sequence.
 *
 * What is NOT here is the authorization. `kube.apply` carries the typed context
 * to a backend that refuses without it; this hook disables a button on the same
 * rule so the user is not offered a call that will fail.
 */

/** What a run is aimed at. */
export interface PipelineTarget {
  /** The project's registry name. */
  readonly project: string;
  /** The repository-relative path — a manifest or a directory of them. */
  readonly path: string;
  readonly action: PipelineAction;
}

/** A run, as the dialog reads it. */
export interface PipelineRun {
  readonly target: PipelineTarget;
  readonly phase: PipelinePhase;
  /** Where this run is aimed, as the backend resolved it. */
  readonly binding: Binding;
  /** The validate — or, for a delete, its dry run. Null for a plain diff. */
  readonly preview: CheckResult | null;
  /** `kubectl diff`, for the actions that show one. */
  readonly diff: CheckResult | null;
  /** The mutation's own output, once it has run. */
  readonly outcome: CheckResult | null;
  /** Why nothing ran, or null. Not kubectl's stderr — see RunEntry.failure. */
  readonly error: string | null;
}

export interface PipelineController {
  /** The open run, or null when the dialog is closed. */
  readonly run: PipelineRun | null;
  /** The active project's runs this session, newest first. */
  readonly log: readonly RunEntry[];
  /** Opens the dialog and starts the read-only steps. */
  start: (action: PipelineAction, path: string) => void;
  /** Step 4, with whatever the user typed into the confirm field. */
  confirm: (typed: string) => void;
  close: () => void;
}

/**
 * Drives one run and keeps the project's session log.
 *
 * `project` is the active project's registry name, or null. Changing it closes
 * whatever is open: a confirm dialog left standing over a project the user has
 * navigated away from is a dialog whose "Apply" reaches a repository they are
 * no longer looking at.
 */
export function usePipeline(project: string | null, kube: Kube): PipelineController {
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [logs, setLogs] = useState<Readonly<Record<string, readonly RunEntry[]>>>({});

  // The seam behind a ref, for the reason `useBlame` documents: a caller
  // passing an inline object rebuilds it every render, and a callback that
  // depended on it would be a new function on every one of them.
  const seam = useRef(kube);
  seam.current = kube;

  // Which run an async result belongs to. Every await below checks it, so a
  // preview that lands after the user closed the dialog — or opened a
  // different one — is dropped rather than painted over what is on screen.
  //
  // It doubles as the log rows' identity. A timestamp alone would not do:
  // `Date.now()` has millisecond resolution and two runs of the same action on
  // the same path can land inside one, which React would read as one row.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setRun(null);
  }, [project]);

  const record = useCallback((name: string, entry: RunEntry) => {
    setLogs((held) => ({ ...held, [name]: logged(held[name] ?? [], entry) }));
  }, []);

  const start = useCallback(
    (action: PipelineAction, path: string) => {
      if (project === null) {
        return;
      }
      const target: PipelineTarget = { project, path, action };
      const mine = (generation.current += 1);
      setRun(opening(target));

      void (async () => {
        const next = await preview(seam.current, target);
        if (generation.current === mine) {
          setRun(next);
        }
      })();
    },
    [project],
  );

  const confirm = useCallback(
    (typed: string) => {
      const open = run;
      if (open === null || open.phase !== "ready" || open.target.action === "diff") {
        return;
      }
      const mine = (generation.current += 1);
      setRun({ ...open, phase: "running" });

      void (async () => {
        const { outcome, error } = await mutate(seam.current, open.target, typed);
        record(open.target.project, entryFor(mine, open, outcome, error));
        if (generation.current === mine) {
          setRun({ ...open, phase: "done", outcome, error });
        }
      })();
    },
    [run, record],
  );

  const close = useCallback(() => {
    generation.current += 1;
    setRun(null);
  }, []);

  return { run, log: (project === null ? undefined : logs[project]) ?? EMPTY_LOG, start, confirm, close };
}

/** A project with no runs yet. A shared constant so the controller's `log` is
 * a stable reference, and a render is not caused by an empty array. */
const EMPTY_LOG: readonly RunEntry[] = [];

/** The run a dialog opens with: on screen immediately, with nothing in it. */
function opening(target: PipelineTarget): PipelineRun {
  return {
    target,
    phase: "previewing",
    binding: UNBOUND,
    preview: null,
    diff: null,
    outcome: null,
    error: null,
  };
}

/**
 * Steps 1 and 2: everything that happens before the user is asked anything.
 *
 * A validation that fails short-circuits — the acceptance criterion is that it
 * blocks *before* any mutation, and running the diff anyway would put a diff of
 * manifests the cluster has already rejected in front of the user, which reads
 * as progress.
 */
async function preview(kube: Kube, target: PipelineTarget): Promise<PipelineRun> {
  const open = opening(target);
  try {
    const binding = await kube.binding(target.project, target.path);
    if (target.action === "diff") {
      const diff = await kube.diff(target.project, target.path);
      return { ...open, phase: "ready", binding, diff };
    }

    const checked = await checkFor(kube, target);
    if (blocks(checked)) {
      return { ...open, phase: "blocked", binding, preview: checked };
    }
    if (target.action === "delete") {
      return { ...open, phase: "ready", binding, preview: checked };
    }
    const diff = await kube.diff(target.project, target.path);
    return { ...open, phase: "ready", binding, preview: checked, diff };
  } catch (failure: unknown) {
    return { ...open, phase: "blocked", error: describe(failure) };
  }
}

/** The read-only step that stands in front of each mutation. */
function checkFor(kube: Kube, target: PipelineTarget): Promise<CheckResult> {
  return target.action === "delete"
    ? kube.deletePreview(target.project, target.path)
    : kube.validate(target.project, target.path);
}

/** Step 4, and its two ways of not working. */
async function mutate(
  kube: Kube,
  target: PipelineTarget,
  typed: string,
): Promise<{ outcome: CheckResult | null; error: string | null }> {
  try {
    const outcome =
      target.action === "delete"
        ? await kube.remove(target.project, target.path, typed)
        : await kube.apply(target.project, target.path, typed);
    return { outcome, error: null };
  } catch (failure: unknown) {
    return { outcome: null, error: describe(failure) };
  }
}

/** The log row for a finished mutation. */
function entryFor(
  id: number,
  run: PipelineRun,
  outcome: CheckResult | null,
  error: string | null,
): RunEntry {
  return {
    id: String(id),
    at: Date.now(),
    action: run.target.action,
    target: run.target.path,
    context: run.binding.context,
    namespace: run.binding.namespace,
    argv: outcome?.argv ?? [],
    exitCode: outcome?.exitCode ?? -1,
    stdout: outcome?.stdout ?? "",
    stderr: outcome?.stderr ?? "",
    failure: error ?? "",
  };
}

/** Renders a rejected binding call as a sentence the dialog can show. */
function describe(failure: unknown): string {
  if (failure instanceof Error) {
    return failure.message;
  }
  return typeof failure === "string" ? failure : "the backend is not reachable";
}
