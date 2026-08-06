import { useEffect, useState } from "react";
import type { Status } from "../lib/git";
import { AVAILABLE } from "../lib/git";
import {
  checkoutBlockedReason,
  defaultRemote,
  needsUpstream,
  pullBlockedReason,
  pushBlockedReason,
} from "../lib/gitOps";

export interface BranchBarProps {
  readonly status: Status;
  readonly branches: readonly string[];
  readonly remotes: readonly string[];
  /** The last operation's failure, verbatim from git. */
  readonly error: string | null;
  readonly busy: boolean;
  readonly onCheckout: (branch: string) => void;
  readonly onPull: () => void;
  readonly onPush: (remote: string, setUpstream: boolean) => void;
  readonly onDismissError: () => void;
}

/**
 * Branch switching and the two remote operations (DESIGN.md §7).
 *
 * It sits above the changes list rather than in the status bar, which already
 * carries the branch *summary*. The distinction is deliberate: the status bar
 * reports, this acts, and putting a control that rewrites the working tree
 * into a line of running text is how a user ends up switching branches by
 * misclick.
 */
export function BranchBar({
  status,
  branches,
  remotes,
  error,
  busy,
  onCheckout,
  onPull,
  onPush,
  onDismissError,
}: BranchBarProps) {
  if (status.availability !== AVAILABLE) {
    return null;
  }

  const switchBlocked = checkoutBlockedReason(status);
  const pullBlocked = pullBlockedReason(status);
  const pushBlocked = pushBlockedReason(status);

  return (
    <section className="branchbar" aria-label="Branch">
      <BranchSelect
        status={status}
        branches={branches}
        busy={busy}
        blocked={switchBlocked}
        onCheckout={onCheckout}
      />

      <button
        type="button"
        className="branchbar__action"
        disabled={busy || pullBlocked !== null}
        title={pullBlocked ?? "Pull from the upstream branch"}
        onClick={onPull}
      >
        Pull
      </button>

      <PushControl
        status={status}
        remotes={remotes}
        busy={busy}
        blocked={pushBlocked}
        onPush={onPush}
      />

      {switchBlocked !== null && branches.length > 0 && (
        <p className="branchbar__blocked" data-testid="checkout-blocked">
          {switchBlocked}
        </p>
      )}

      <OperationError error={error} onDismiss={onDismissError} />
    </section>
  );
}

interface BranchSelectProps {
  readonly status: Status;
  readonly branches: readonly string[];
  readonly busy: boolean;
  readonly blocked: string | null;
  readonly onCheckout: (branch: string) => void;
}

/** The branch dropdown. */
function BranchSelect({ status, branches, busy, blocked, onCheckout }: BranchSelectProps) {
  const { detached, name } = status.branch;
  // The checked-out branch is not always one of the options: a detached HEAD
  // names no branch, and a fresh project has no list yet. Without a placeholder
  // the select would silently display the first branch in the list as if it
  // were checked out, which is a claim about the working tree that is false.
  const unlisted = detached || !branches.includes(name);

  return (
    <select
      className="branchbar__branch"
      aria-label="Branch"
      value={detached ? "" : name}
      disabled={busy || blocked !== null || branches.length === 0}
      title={blocked ?? "Switch branch"}
      onChange={(event) => {
        // The blocked check is repeated here rather than left to `disabled`. A
        // checkout can overwrite uncommitted work, and the attribute is a
        // rendering decision one refactor away from being conditional on
        // something else; this is the rule itself. The empty value is the
        // placeholder above, which is a label, not a branch.
        const chosen = event.target.value;
        if (blocked === null && chosen !== "" && chosen !== name) {
          onCheckout(chosen);
        }
      }}
    >
      {unlisted && <option value="">{detached ? "detached HEAD" : name}</option>}
      {branches.map((branch) => (
        <option key={branch} value={branch}>
          {branch}
        </option>
      ))}
    </select>
  );
}

/**
 * A failed operation's message.
 *
 * It is git's stderr and it is shown as git wrote it (DESIGN.md §7) — a `pre`
 * rather than a paragraph, because git's errors carry hints on their own lines
 * and folding them into running text is a translation of a kind.
 */
function OperationError({
  error,
  onDismiss,
}: {
  readonly error: string | null;
  readonly onDismiss: () => void;
}) {
  if (error === null) {
    return null;
  }
  return (
    <div className="branchbar__error" role="alert">
      <pre className="branchbar__stderr">{error}</pre>
      <button type="button" className="branchbar__dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

interface PushControlProps {
  readonly status: Status;
  readonly remotes: readonly string[];
  readonly busy: boolean;
  readonly blocked: string | null;
  readonly onPush: (remote: string, setUpstream: boolean) => void;
}

/**
 * Push, with the upstream prompt a branch that tracks nothing needs.
 *
 * A branch with an upstream pushes on one click and no remote is named: git's
 * own push configuration already knows where it goes. A branch without one
 * cannot — `git push` would fail — so the remote picker appears, and the push
 * that follows carries `--set-upstream`. The prompt is inline rather than a
 * dialog because it is one choice with an obvious default, and a modal for it
 * would interrupt the flow it is part of.
 */
function PushControl({ status, remotes, busy, blocked, onPush }: PushControlProps) {
  const prompting = needsUpstream(status);
  const [remote, setRemote] = useState("");

  // The default follows the remote list, which arrives after the first render
  // and changes with the project. A user's own choice survives it: once
  // `remote` names a remote this repository has, nothing overwrites it.
  useEffect(() => {
    setRemote((current) => (remotes.includes(current) ? current : defaultRemote(remotes)));
  }, [remotes]);

  if (!prompting) {
    return (
      <button
        type="button"
        className="branchbar__action"
        disabled={busy || blocked !== null}
        title={blocked ?? "Push to the upstream branch"}
        onClick={() => {
          onPush("", false);
        }}
      >
        Push
      </button>
    );
  }

  const noRemote = remotes.length === 0;
  return (
    <span className="branchbar__upstream">
      <select
        className="branchbar__remote"
        aria-label="Remote"
        value={remote}
        disabled={busy || noRemote}
        onChange={(event) => {
          setRemote(event.target.value);
        }}
      >
        {noRemote && <option value="">no remotes configured</option>}
        {remotes.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="branchbar__action"
        disabled={busy || noRemote || remote === "" || blocked !== null}
        title={blocked ?? `Publish ${status.branch.name} to ${remote} and track it`}
        onClick={() => {
          onPush(remote, true);
        }}
      >
        Publish
      </button>
    </span>
  );
}
