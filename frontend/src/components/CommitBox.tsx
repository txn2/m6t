import { useState } from "react";
import type { Status } from "../lib/git";
import { AVAILABLE } from "../lib/git";
import type { CommitDraft } from "../lib/gitOps";
import { EMPTY_DRAFT, commitBlockedReason, commitMessage, stagedPaths } from "../lib/gitOps";

export interface CommitBoxProps {
  readonly status: Status;
  /** Records the index. Resolves true when the commit was made, which is what
   * clears the editor — a draft dropped on a failed commit is a draft the
   * user has to retype. */
  readonly onCommit: (message: string) => Promise<boolean>;
  readonly busy: boolean;
}

/**
 * The commit message editor (DESIGN.md §7): a subject line, an optional body,
 * and a button that is disabled with a reason.
 *
 * Two fields rather than one textarea because the subject is not just the
 * first line — it is what every log, every blame and every PR title shows, and
 * a separate input is what makes its length visible while it is being typed.
 *
 * Signing is not mentioned anywhere here. Whether a commit is signed is the
 * repository's `commit.gpgsign`, m6t runs the user's own git, and a checkbox
 * offering to override it would be m6t having an opinion about a policy it did
 * not set.
 */
export function CommitBox({ status, onCommit, busy }: CommitBoxProps) {
  const [draft, setDraft] = useState<CommitDraft>(EMPTY_DRAFT);

  if (status.availability !== AVAILABLE) {
    return null;
  }

  const blocked = commitBlockedReason(status, draft);
  const staged = stagedPaths(status).length;

  const submit = () => {
    void onCommit(commitMessage(draft)).then((committed) => {
      if (committed) {
        setDraft(EMPTY_DRAFT);
      }
    });
  };

  return (
    <section className="commit" aria-label="Commit">
      <input
        type="text"
        className="commit__subject"
        aria-label="Commit subject"
        placeholder="Summary"
        value={draft.subject}
        disabled={busy}
        onChange={(event) => {
          setDraft((current) => ({ ...current, subject: event.target.value }));
        }}
      />
      <textarea
        className="commit__body"
        aria-label="Commit body"
        placeholder="Description (optional)"
        rows={3}
        value={draft.body}
        disabled={busy}
        onChange={(event) => {
          setDraft((current) => ({ ...current, body: event.target.value }));
        }}
      />
      <div className="commit__actions">
        <button
          type="button"
          className="commit__submit"
          disabled={busy || blocked !== null}
          // The button is disabled, so its own tooltip would never appear on
          // hover in most browsers; the reason is rendered below as well.
          title={blocked ?? `Commit ${String(staged)} staged file(s)`}
          onClick={submit}
        >
          Commit
        </button>
        <span className="commit__staged" data-testid="commit-staged">
          {stagedLabel(staged)}
        </span>
      </div>
      {blocked !== null && (
        <p className="commit__blocked" data-testid="commit-blocked">
          {blocked}
        </p>
      )}
    </section>
  );
}

function stagedLabel(count: number): string {
  if (count === 0) {
    return "nothing staged";
  }
  return count === 1 ? "1 file staged" : `${String(count)} files staged`;
}
