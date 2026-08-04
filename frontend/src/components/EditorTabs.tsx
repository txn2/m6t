import { useState } from "react";
import type { EditorTab } from "../lib/editorTabs";
import { canSave, isDirty } from "../lib/editorTabs";

/**
 * The editor tab strip: one tab per open file (DESIGN.md §5).
 *
 * It is a separate strip from the terminal's, sitting above the editor pane
 * rather than the terminal pane, and it shares no state with it — the two
 * hold different things and close on different rules.
 */
export interface EditorTabsProps {
  readonly tabs: readonly EditorTab[];
  readonly activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Resolves true when the file reached disk — see `onSaveAndClose`. */
  onSave: (key: string) => Promise<boolean>;
  onPreview: (key: string, preview: boolean) => void;
}

export function EditorTabs({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onSave,
  onPreview,
}: EditorTabsProps) {
  // The tab whose close is waiting on an answer. One at a time: the prompt
  // replaces the tab in the strip, so two at once would be two tabs the user
  // can no longer see the names of.
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="tabs tabs--editor" role="tablist" aria-label="editor tabs">
      {tabs.map((tab) =>
        confirming === tab.key ? (
          <CloseConfirm
            key={tab.key}
            tab={tab}
            onCancel={() => {
              setConfirming(null);
            }}
            onDiscard={() => {
              setConfirming(null);
              onClose(tab.key);
            }}
            // The close waits on the write. Closing first would take the
            // only copy of the user's edits with it whenever the save turned
            // out to fail — the tab stays, holding its buffer and the error
            // the hook recorded on it.
            onSaveAndClose={() => {
              setConfirming(null);
              void onSave(tab.key).then((written) => {
                if (written) {
                  onClose(tab.key);
                }
              });
            }}
          />
        ) : (
          <Tab
            key={tab.key}
            tab={tab}
            active={tab.key === activeKey}
            onSelect={onSelect}
            onPreview={onPreview}
            onRequestClose={() => {
              // A clean tab closes immediately; only unsaved work is worth
              // interrupting the user for.
              if (isDirty(tab)) {
                setConfirming(tab.key);
                return;
              }
              onClose(tab.key);
            }}
          />
        ),
      )}
    </div>
  );
}

interface TabProps {
  readonly tab: EditorTab;
  readonly active: boolean;
  onSelect: (key: string) => void;
  onPreview: (key: string, preview: boolean) => void;
  onRequestClose: () => void;
}

function Tab({ tab, active, onSelect, onPreview, onRequestClose }: TabProps) {
  const dirty = isDirty(tab);

  return (
    <div className={`tab${active ? " tab--active" : ""}`}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="tab__label"
        title={tab.path}
        onClick={() => {
          onSelect(tab.key);
        }}
      >
        <span className={`tab__icon tab__icon--${tab.kind}`} aria-hidden="true" />
        {tab.title}
        {dirty && (
          <span className="tab__dirty" aria-label="unsaved changes">
            ●
          </span>
        )}
      </button>

      {tab.kind === "markdown" && (
        <button
          type="button"
          className="tab__mode"
          aria-pressed={tab.mode === "preview"}
          aria-label={
            tab.mode === "preview" ? `edit ${tab.title}` : `preview ${tab.title}`
          }
          onClick={() => {
            onPreview(tab.key, tab.mode !== "preview");
          }}
        >
          {tab.mode === "preview" ? "✎" : "◉"}
        </button>
      )}

      <button
        type="button"
        className="tab__close"
        aria-label={`close ${tab.title}`}
        onClick={onRequestClose}
      >
        ✕
      </button>
    </div>
  );
}

interface CloseConfirmProps {
  readonly tab: EditorTab;
  onCancel: () => void;
  onDiscard: () => void;
  onSaveAndClose: () => void;
}

/**
 * The unsaved-changes prompt, inline in the strip.
 *
 * Cancel is the default — it is what Escape and a click elsewhere both do —
 * because the destructive answer is the one that has to be chosen
 * deliberately. This is the tree's delete-confirmation convention rather than
 * the terminal strip's rename convention, where blur commits: what is at
 * stake here is the user's unsaved work, not a label.
 */
function CloseConfirm({ tab, onCancel, onDiscard, onSaveAndClose }: CloseConfirmProps) {
  return (
    <div
      className="tab tab--confirm"
      role="alertdialog"
      aria-label={`${tab.title} has unsaved changes`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <span className="tab__label">{tab.title}?</span>
      {/* A read-only tab cannot be saved, so its only real choice is to
          discard — offering a button that would silently do nothing would be
          worse than not offering it. */}
      {canSave(tab) && (
        <button type="button" onClick={onSaveAndClose}>
          Save
        </button>
      )}
      <button type="button" onClick={onDiscard}>
        Discard
      </button>
      <button type="button" autoFocus onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
