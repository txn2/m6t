import { useEffect, useState } from "react";
import type { CheckResult } from "../lib/kube";
import type { PipelineController, PipelineRun } from "../lib/usePipeline";
import { actionVerb, authorized, diffVerdict, guarded } from "../lib/pipeline";
import { DiffView } from "./DiffView";
import { UiIcon } from "./Icon";
/** The Kubernetes wheel, vendored with the file-type marks (see Icon.tsx). */
import kubernetesMark from "../icons/material/kubernetes.svg";

/**
 * The pipeline dialog, wired to its controller.
 *
 * A component rather than a conditional inside `App`, for the reason
 * `FolderDialog` gives: the workbench is at its branch ceiling, and "is a run
 * open" is a branch that belongs beside the dialog it opens rather than in the
 * component that has to fit every other decision in the window.
 */
export function Pipeline({ controller }: { readonly controller: PipelineController }) {
  if (controller.run === null) {
    return null;
  }
  return (
    <PipelineDialog
      run={controller.run}
      onConfirm={controller.confirm}
      onClose={controller.close}
    />
  );
}

export interface PipelineDialogProps {
  readonly run: PipelineRun;
  /** Step 4, with what the user typed into the confirm field. */
  onConfirm: (typed: string) => void;
  onClose: () => void;
}

/**
 * The diff → apply pipeline, on screen (DESIGN.md §6.1, issue #11).
 *
 * The dialog IS step 3. Steps 1 and 2 have already run by the time it can be
 * answered, and everything they produced is in front of the user when they
 * answer it: the target cluster and namespace, the objects the dry run
 * resolved, and the diff. A confirm dialog that asked "are you sure?" over a
 * spinner would be a dialog that trains people to press the button.
 *
 * The order is deliberate and does not change between the actions. Where it is
 * going is first, because that is the question a mistake gets wrong; what would
 * change is second; the button is last, under everything it is agreeing to.
 */
export function PipelineDialog({ run, onConfirm, onClose }: PipelineDialogProps) {
  const [typed, setTyped] = useState("");
  const verb = actionVerb(run.target.action);
  const busy = run.phase === "previewing" || run.phase === "running";

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      // Escape closes, and closing an unanswered dialog is a refusal — but not
      // while the mutation is in flight, where there is nothing left to refuse
      // and the output is what the user is waiting for.
      if (event.key === "Escape" && run.phase !== "running") {
        onClose();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, [onClose, run.phase]);

  return (
    <div className="settings__backdrop" role="presentation">
      <div
        className="settings pipeline"
        role="dialog"
        aria-modal="true"
        aria-label={`${verb} ${run.target.path}`}
        data-protected={run.binding.protected || undefined}
      >
        <h2 className="settings__title">
          <img className="icon" src={kubernetesMark} alt="" />
          {verb} {run.target.path}
        </h2>

        <Destination run={run} />

        <Body run={run} typed={typed} onTyped={setTyped} />

        <footer className="settings__actions">
          <span className="settings__spacer" />
          <button
            type="button"
            className="settings__cancel"
            disabled={run.phase === "running"}
            onClick={onClose}
          >
            {run.phase === "done" ? "Close" : "Cancel"}
          </button>

          {run.phase === "ready" && run.target.action !== "diff" && (
            <button
              type="button"
              className="settings__save pipeline__go"
              disabled={busy || !authorized(run.binding, typed)}
              onClick={() => {
                onConfirm(typed);
              }}
            >
              {verb}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/**
 * Where this run is aimed, restated (DESIGN.md §6.1, step 3).
 *
 * It is at the top of every phase and not only of the confirm, because the
 * question "which cluster is this" is the one a user asks while the preview is
 * still running, and an answer that appeared only at the end would arrive after
 * they had already decided.
 */
function Destination({ run }: { readonly run: PipelineRun }) {
  const { context, namespace, scope } = run.binding;
  // A run opens before the backend has answered where it is aimed. Saying "not
  // bound" in that gap and then replacing it a moment later would make the one
  // line the user is supposed to check the one line that changes under them —
  // so the unresolved state says it is unresolved.
  const pending = run.phase === "previewing" && context === "";

  return (
    <section className="pipeline__target" aria-label="Target">
      <p className="panel__fact">
        <span className="panel__fact-label">cluster</span>
        <span className="panel__fact-value">{pending ? "resolving…" : blank(context, "not bound")}</span>
      </p>
      <p className="panel__fact">
        <span className="panel__fact-label">namespace</span>
        <span className="panel__fact-value">{pending ? "resolving…" : blank(namespace, "not set")}</span>
      </p>
      {!pending && (
        <p className="panel__fact">
          <span className="panel__fact-label">from</span>
          <span className="panel__fact-value">
            {scope === "" ? "the project default" : `the ${scope} override`}
          </span>
        </p>
      )}
    </section>
  );
}

/** A field's value, or what to say when it has none. */
function blank(value: string, empty: string): string {
  return value === "" ? empty : value;
}

/** The confirm field's state, threaded down to the one section that owns it.
 * It lives on the dialog rather than in `PipelineRun` because it is the user's
 * half-finished answer, and the run is what the backend said. */
interface Confirming {
  readonly typed: string;
  onTyped: (value: string) => void;
}

/** Whatever the run's current phase has to show. */
function Body({ run, typed, onTyped }: { readonly run: PipelineRun } & Confirming) {
  if (run.phase === "previewing") {
    return <p className="settings__hint">Asking the cluster what would change…</p>;
  }
  if (run.phase === "running") {
    return <p className="settings__hint">Running…</p>;
  }
  if (run.phase === "blocked") {
    return <Blocked run={run} />;
  }
  if (run.phase === "done") {
    return <Outcome run={run} />;
  }
  return <Preview run={run} typed={typed} onTyped={onTyped} />;
}

/**
 * A run that stopped at step 1.
 *
 * The acceptance criterion this serves: a validation failure — a bad kind, a
 * schema error, an RBAC denial — blocks before any mutation, with stderr shown.
 * There is no button past this point, which is the whole of "blocks".
 */
function Blocked({ run }: { readonly run: PipelineRun }) {
  return (
    <section className="pipeline__blocked" aria-label="Blocked">
      <p className="settings__error" role="alert">
        <UiIcon name="lock" />
        {run.target.action === "delete"
          ? "The cluster refused the dry run, so nothing has been deleted."
          : "The manifests did not validate, so nothing has been applied."}
      </p>
      {run.error !== null && <p className="settings__error">{run.error}</p>}
      {run.preview !== null && <Output result={run.preview} />}
    </section>
  );
}

/** What steps 1 and 2 found, and — when the binding is protected — the field
 * that has to be filled in before step 4 is offered. */
function Preview({ run, typed, onTyped }: { readonly run: PipelineRun } & Confirming) {
  return (
    <>
      {run.preview !== null && run.preview.stdout !== "" && (
        <section className="pipeline__objects" aria-label="Objects">
          <h3 className="panel__section-title">
            {run.target.action === "delete" ? "Would be deleted" : "Would be applied"}
          </h3>
          <pre className="pipeline__list">{run.preview.stdout}</pre>
        </section>
      )}

      {run.diff !== null && <DiffSection result={run.diff} />}

      {guarded(run.binding) && run.target.action !== "diff" && (
        <TypedConfirm run={run} typed={typed} onTyped={onTyped} />
      )}
    </>
  );
}

/**
 * The diff, or the fact that there is nothing to show.
 *
 * "No changes" is a sentence rather than an empty pane, which DESIGN.md §6.1
 * asks for by name: an empty box is indistinguishable from a diff that failed
 * to render, and the two mean opposite things.
 */
function DiffSection({ result }: { readonly result: CheckResult }) {
  const verdict = diffVerdict(result);
  return (
    <section className="pipeline__diff" aria-label="Diff">
      <h3 className="panel__section-title">Changes</h3>
      {verdict === "same" && (
        <p className="pipeline__same">The cluster already matches these manifests.</p>
      )}
      {verdict === "differs" && <DiffView output={result.stdout} />}
      {verdict === "failed" && <Output result={result} />}
      {/* The diff's own command, whatever the verdict — it is what DiffView's
          truncation note tells the user to run, and DESIGN.md §1's promise
          applies to the step that produced what is on screen. */}
      {verdict !== "failed" && <Argv result={result} />}
    </section>
  );
}

/**
 * The typed confirmation a protected binding requires (DESIGN.md §6.1).
 *
 * The context name is on screen above this field, and that is deliberate: this
 * is not a memory test, it is a step that cannot be taken absent-mindedly. What
 * it costs is the second of deliberate typing that separates applying to `dev`
 * from applying to `prod-us-west`.
 *
 * The field enables the button and does not authorize the call. The backend
 * checks the same value against the same context and refuses without it — see
 * internal/app/pipeline.go.
 */
function TypedConfirm({ run, typed, onTyped }: { readonly run: PipelineRun } & Confirming) {
  return (
    <section className="pipeline__confirm" aria-label="Confirmation">
      <p className="panel__protected">
        <UiIcon name="lock" />
        This binding is protected. Type <strong>{run.binding.context}</strong> to
        continue.
      </p>
      <label className="settings__field">
        <span>context name</span>
        <input
          type="text"
          className="pipeline__typed"
          // Nothing helps here. A field that offered the answer back would be a
          // confirmation the browser can complete on the user's behalf.
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => {
            onTyped(event.target.value);
          }}
        />
      </label>
    </section>
  );
}

/** A finished mutation: what kubectl said, and whether it worked. */
function Outcome({ run }: { readonly run: PipelineRun }) {
  if (run.error !== null) {
    return (
      <p className="settings__error" role="alert">
        {run.error}
      </p>
    );
  }
  if (run.outcome === null) {
    return null;
  }
  return (
    <section className="pipeline__outcome" aria-label="Result">
      <p className={run.outcome.exitCode === 0 ? "pipeline__same" : "settings__error"}>
        {run.outcome.exitCode === 0
          ? "Done."
          : `kubectl exited ${String(run.outcome.exitCode)}`}
      </p>
      <Output result={run.outcome} />
    </section>
  );
}

/**
 * One invocation's output and the command that produced it.
 *
 * kubectl's stderr is shown verbatim (CLAUDE.md): the user knows how to read
 * "error validating data" and a translation would lose the line number that
 * makes it actionable. The argv is beside it because DESIGN.md §1 promises
 * everything m6t does is something the user could have typed themselves.
 */
function Output({ result }: { readonly result: CheckResult }) {
  return (
    <>
      {result.stderr !== "" && <pre className="panel__stderr">{result.stderr}</pre>}
      {result.stdout !== "" && <pre className="pipeline__list">{result.stdout}</pre>}
      <Argv result={result} />
    </>
  );
}

/** The command one step ran, folded away (DESIGN.md §1). */
function Argv({ result }: { readonly result: CheckResult }) {
  return (
    <details className="panel__argv">
      <summary>command</summary>
      <pre>{(result.argv ?? []).join(" ")}</pre>
    </details>
  );
}
