import { useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { EditorTab } from "../lib/editorTabs";
import { absolutePath, canSave, isDirty, relativePath } from "../lib/editorTabs";
import { iconKind, looksLikeManifest, resolveIconKind } from "../lib/tree";
import { FileIcon, UiIcon } from "./Icon";

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
  // The dirty tabs waiting on an answer, in the order they will be asked
  // about. One at a time: the prompt replaces the tab in the strip, so two at
  // once would be two tabs the user can no longer see the names of.
  const [queue, setQueue] = useState<readonly string[]>([]);

  // Filtered against the strip on every render rather than pruned in an
  // effect: a project switch replaces `tabs` wholesale, and a key left
  // pointing at a tab this strip no longer shows would sit at the head of the
  // queue holding up every close behind it.
  const pending = queue.filter((key) => tabs.some((tab) => tab.key === key));
  const confirming = pending[0] ?? null;

  /**
   * Closes a set of tabs: the clean ones now, the dirty ones once the user
   * has answered for each.
   *
   * This is the only close path in the strip. The × on a tab asks for one tab
   * and the menu's bulk items ask for several, which is the whole of the
   * difference between them — a "Close All" over unsaved work cannot discard
   * anything the × would have asked about first (#42).
   */
  const requestClose = (closing: readonly EditorTab[]) => {
    for (const tab of closing) {
      if (!isDirty(tab)) {
        onClose(tab.key);
      }
    }
    const fresh = closing
      .filter(isDirty)
      .map((tab) => tab.key)
      .filter((key) => !pending.includes(key));
    if (fresh.length > 0) {
      setQueue([...pending, ...fresh]);
    }
  };

  /** Moves the prompt on to the next dirty tab, if there is one. */
  const answered = () => {
    setQueue(pending.slice(1));
  };

  return (
    <div className="tabs tabs--editor" role="tablist" aria-label="editor tabs">
      {tabs.map((tab) =>
        confirming === tab.key ? (
          <CloseConfirm
            key={tab.key}
            tab={tab}
            // Cancel answers for the rest of the queue too. Having declined a
            // bulk close once, the user should not have to decline it again
            // per file; the clean tabs it already closed stay closed.
            onCancel={() => {
              setQueue([]);
            }}
            onDiscard={() => {
              answered();
              onClose(tab.key);
            }}
            // The close waits on the write. Closing first would take the
            // only copy of the user's edits with it whenever the save turned
            // out to fail — the tab stays, holding its buffer and the error
            // the hook recorded on it. The queue moves on either way: the
            // next file's question does not depend on this file's write.
            onSaveAndClose={() => {
              answered();
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
            siblings={tabs}
            active={tab.key === activeKey}
            onSelect={onSelect}
            onPreview={onPreview}
            onRequestClose={requestClose}
          />
        ),
      )}
    </div>
  );
}

interface TabProps {
  readonly tab: EditorTab;
  /** Every tab in this strip — what the menu's bulk closes are drawn from. */
  readonly siblings: readonly EditorTab[];
  readonly active: boolean;
  onSelect: (key: string) => void;
  onPreview: (key: string, preview: boolean) => void;
  onRequestClose: (closing: readonly EditorTab[]) => void;
}

function Tab({ tab, siblings, active, onSelect, onPreview, onRequestClose }: TabProps) {
  const dirty = isDirty(tab);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
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
            <span className="tab__icon">
              {/* The tab already holds the file, so the same content rule the
                  tree runs against a 2 KiB head (#38) runs here for free —
                  which is what keeps a manifest's tab and its tree row from
                  disagreeing about what it is. */}
              <FileIcon
                kind={resolveIconKind(iconKind(tab.path, false), looksLikeManifest(tab.content))}
              />
            </span>
            {tab.title}
            {dirty && (
              <span className="tab__dirty" aria-label="unsaved changes">
                <UiIcon name="dirty" />
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
              <UiIcon name={tab.mode === "preview" ? "edit" : "preview"} />
            </button>
          )}

          <button
            type="button"
            className="tab__close"
            aria-label={`close ${tab.title}`}
            onClick={() => {
              onRequestClose([tab]);
            }}
          >
            <UiIcon name="close" />
          </button>
        </div>
      </ContextMenu.Trigger>

      <TabMenu tab={tab} siblings={siblings} onRequestClose={onRequestClose} />
    </ContextMenu.Root>
  );
}

interface TabMenuProps {
  readonly tab: EditorTab;
  readonly siblings: readonly EditorTab[];
  onRequestClose: (closing: readonly EditorTab[]) => void;
}

/**
 * A tab's context menu (#42): the four closes and the two copies.
 *
 * Radix owns the menu itself — placement inside the window, Escape,
 * click-outside, focus return and arrow-key navigation — which is the same
 * delegation the project strip makes, for the same reasons (ProjectTab.tsx).
 *
 * Every close here hands a *set of tabs* back to the strip rather than closing
 * anything itself. That is what keeps one dirty-check in front of all four:
 * there is no second close path here for the prompt to be forgotten on.
 */
function TabMenu({ tab, siblings, onRequestClose }: TabMenuProps) {
  // "Saved" is every tab with nothing unwritten, which includes one still
  // loading and one that failed to load: neither has a buffer to lose.
  const saved = siblings.filter((other) => !isDirty(other));
  const others = siblings.filter((other) => other.key !== tab.key);

  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className="tabs__menu" aria-label={`${tab.title} actions`}>
        <Item
          label="Close"
          onSelect={() => {
            onRequestClose([tab]);
          }}
        />
        <Item
          label="Close Others"
          onSelect={() => {
            onRequestClose(others);
          }}
        />
        <Item
          label="Close All"
          onSelect={() => {
            onRequestClose(siblings);
          }}
        />
        <Item
          label="Close Saved"
          onSelect={() => {
            onRequestClose(saved);
          }}
        />

        <ContextMenu.Separator className="tabs__menu-rule" />

        <Item
          label="Copy Path"
          onSelect={() => {
            copyToClipboard(absolutePath(tab));
          }}
        />
        <Item
          label="Copy Relative Path"
          onSelect={() => {
            copyToClipboard(relativePath(tab));
          }}
        />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

interface ItemProps {
  readonly label: string;
  onSelect: () => void;
}

function Item({ label, onSelect }: ItemProps) {
  return (
    <ContextMenu.Item className="tabs__menu-item" onSelect={onSelect}>
      {label}
    </ContextMenu.Item>
  );
}

/**
 * Puts a path on the system clipboard.
 *
 * A refused write is dropped rather than reported: the strip is one row of
 * chrome with nowhere to put a message, and the terminal's copy chord
 * (lib/xterm.ts) already treats the same call the same way. It is dropped
 * deliberately — an uncaught rejection would land in a console the user is
 * not reading either.
 */
function copyToClipboard(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {
    // Nothing on the clipboard, and nothing the user could do about it.
  });
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
