import type { Binding, CheckResult } from "./kube";

/**
 * The diff → apply pipeline's model (DESIGN.md §6.1, issue #11): the rules
 * about what each step's outcome means, with no I/O and no React in them.
 *
 * The split is the one `blame.ts` already uses. `usePipeline` owns the calls
 * and the run in progress, `PipelineDialog` owns what is on screen, and this
 * owns the answers — which is what lets "a protected apply needs the context
 * typed exactly" be a test with no cluster behind it.
 *
 * Nothing here decides whether a mutation may proceed. `internal/app` does
 * that, before any process exists, and `authorized` below is the frontend's
 * copy of the same rule for the sole purpose of disabling a button. A UI that
 * were the only guard would be a guard that a second caller could skip.
 */

/** What a run is for. */
export type PipelineAction = "apply" | "delete" | "diff";

/** Where a run has got to. */
export type PipelinePhase =
  /** The read-only steps are running: validate, or the delete's dry run. */
  | "previewing"
  /** A preview step refused, so there is nothing to confirm. */
  | "blocked"
  /** The preview is in, and the user is being asked (step 3). */
  | "ready"
  /** The mutation is in flight. */
  | "running"
  /** It finished, for better or worse. */
  | "done";

/** What kubectl diff's exit code says (DESIGN.md §6.1). */
export type DiffVerdict = "same" | "differs" | "failed";

/**
 * Reads a `kubectl diff` exit code.
 *
 * 0 is "the cluster already matches", which is a first-class result rather
 * than an empty screen — the whole point of running the step is to be told
 * this. 1 is "there are differences". Anything above 1 is the command itself
 * having failed, and the two must not be conflated: a diff that could not run
 * looks exactly like a diff with changes if the only thing checked is
 * "non-zero".
 */
export function diffVerdict(result: CheckResult): DiffVerdict {
  if (result.exitCode === 0) {
    return "same";
  }
  return result.exitCode === 1 ? "differs" : "failed";
}

/**
 * Whether a preview step's result blocks the pipeline.
 *
 * It is only asked of the steps that stand in front of a mutation — the
 * validate and the delete's dry run. A plain diff is never put through it: the
 * diff IS the whole run there, and a non-zero exit is its ordinary answer
 * rather than a gate on something further.
 */
export function blocks(result: CheckResult): boolean {
  return result.exitCode !== 0;
}

/**
 * Whether this binding makes the user type the context name (DESIGN.md §6.1).
 */
export function guarded(binding: Binding): boolean {
  return binding.protected;
}

/**
 * Whether what the user typed authorizes a mutation on this binding.
 *
 * Exact, because the backend's check is exact: a control enabled on a looser
 * rule than the one behind it would offer a button that fails, which teaches
 * the user that the failure is noise.
 */
export function authorized(binding: Binding, typed: string): boolean {
  return !guarded(binding) || typed === binding.context;
}

/** How a diff line is rendered. */
export type DiffLineKind = "added" | "removed" | "meta" | "context";

/** One line of `kubectl diff` output. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/**
 * How many diff lines are rendered.
 *
 * A first apply of a large chart produces a diff of every field of every
 * object, and putting fifty thousand DOM nodes in a dialog is how the window
 * stops responding. What is dropped is reported rather than silently cut — see
 * `omitted`.
 */
export const MAX_DIFF_LINES = 2000;

/**
 * Splits `kubectl diff` output into the lines a viewer renders.
 *
 * The classification is the unified-diff one, and the order of the tests is
 * load-bearing: `---` and `+++` are file headers and would otherwise read as a
 * removal and an addition of a line of dashes, which is the classic way a diff
 * viewer paints its own headers red and green.
 */
export function diffLines(output: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const text of output.split("\n").slice(0, MAX_DIFF_LINES)) {
    lines.push({ kind: diffLineKind(text), text });
  }
  // A trailing newline is a line terminator, not an empty last line.
  if (lines.length > 0 && lines[lines.length - 1].text === "") {
    lines.pop();
  }
  return lines;
}

function diffLineKind(text: string): DiffLineKind {
  if (text.startsWith("---") || text.startsWith("+++") || text.startsWith("@@")) {
    return "meta";
  }
  if (text.startsWith("diff ") || text.startsWith("index ")) {
    return "meta";
  }
  if (text.startsWith("+")) {
    return "added";
  }
  return text.startsWith("-") ? "removed" : "context";
}

/** How many lines `diffLines` left out, so the viewer can say so. */
export function omitted(output: string): number {
  return Math.max(0, output.split("\n").length - MAX_DIFF_LINES);
}

/** One run, as the project's session history holds it. */
export interface RunEntry {
  /** Unique within a session; the list's React key. */
  readonly id: string;
  /** Epoch milliseconds, for the time the row shows. */
  readonly at: number;
  readonly action: PipelineAction;
  /** The repository-relative path the run acted on. */
  readonly target: string;
  readonly context: string;
  readonly namespace: string;
  /** The argv, so the row can show the command the user could have typed. */
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Why no command ran at all, or "".
   *
   * It is a separate field from stderr because they are separate failures: a
   * refused confirmation and an unreachable API server are both "it did not
   * work", and only one of them has kubectl's own words to show.
   */
  readonly failure: string;
}

/**
 * How many runs a project's log keeps.
 *
 * The log is this session's and lives in memory (issue #11: audit persistence
 * is v2), so it is bounded for the reason any in-memory list is. Fifty is well
 * past what anyone scrolls back through in one sitting.
 */
export const RUN_LOG_LIMIT = 50;

/** Adds a run to a project's log, newest first, within the limit. */
export function logged(log: readonly RunEntry[], entry: RunEntry): RunEntry[] {
  return [entry, ...log].slice(0, RUN_LOG_LIMIT);
}

/** Whether a run did what it set out to do. */
export function succeeded(entry: RunEntry): boolean {
  return entry.failure === "" && entry.exitCode === 0;
}

/** The verb a row and a dialog title use for an action. */
export function actionVerb(action: PipelineAction): string {
  if (action === "apply") {
    return "Apply";
  }
  return action === "delete" ? "Delete" : "Diff";
}

/**
 * A run's one-line outcome.
 *
 * A failure that never reached kubectl says so in its own words; everything
 * else is the exit code, because kubectl's own message is already on the row
 * underneath and repeating it in a summary would only make it longer.
 */
export function runSummary(entry: RunEntry): string {
  if (entry.failure !== "") {
    return entry.failure;
  }
  if (entry.exitCode === 0) {
    return entry.action === "diff" ? "no changes" : "succeeded";
  }
  if (entry.action === "diff" && entry.exitCode === 1) {
    return "changes pending";
  }
  return `kubectl exited ${String(entry.exitCode)}`;
}

/** `HH:MM:SS`, which is the only part of a timestamp a session log needs. */
export function runTime(at: number): string {
  const moment = new Date(at);
  return [moment.getHours(), moment.getMinutes(), moment.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/**
 * Whether the pipeline is offered on a tree row at all.
 *
 * Directories, because a subtree is what a manifest repository is applied by,
 * and YAML files, because those are the manifests. Everything else — a
 * README, a values file's sibling script — has no apply that would mean
 * anything, and a menu entry that fails on click is worse than one that is not
 * there (#38 makes the same argument about the tree's own menu).
 */
export function actionable(path: string, isDir: boolean): boolean {
  if (isDir) {
    return true;
  }
  const lower = path.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}
