import { useEffect, useRef, useState } from "react";
import type { TerminalTab } from "../lib/tabs";

/**
 * The terminal tab strip: one tab per PTY session, plus the two ways to open
 * one.
 *
 * Selecting a tab only changes which pane is visible. Nothing here starts,
 * stops or reconnects a session — closing a tab is the single exception, and it
 * is the user saying so.
 */
export interface TerminalTabsProps {
  readonly tabs: readonly TerminalTab[];
  readonly activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onRename: (key: string, title: string) => void;
  onCreate: () => void;
  onCreateClaude: () => void;
}

export function TerminalTabs({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onRename,
  onCreate,
  onCreateClaude,
}: TerminalTabsProps) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="tabs" role="tablist" aria-label="terminal tabs">
      {tabs.map((tab) => (
        <Tab
          key={tab.key}
          tab={tab}
          active={tab.key === activeKey}
          editing={editing === tab.key}
          onSelect={onSelect}
          onClose={onClose}
          onEdit={setEditing}
          onRename={onRename}
        />
      ))}
      <button type="button" className="tabs__add" onClick={onCreate}>
        + shell
      </button>
      <button type="button" className="tabs__add" onClick={onCreateClaude}>
        + Claude Code
      </button>
    </div>
  );
}

interface TabProps {
  readonly tab: TerminalTab;
  readonly active: boolean;
  readonly editing: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onEdit: (key: string | null) => void;
  onRename: (key: string, title: string) => void;
}

function Tab({
  tab,
  active,
  editing,
  onSelect,
  onClose,
  onEdit,
  onRename,
}: TabProps) {
  if (editing) {
    return (
      <RenameField
        tab={tab}
        onCommit={(title) => {
          onRename(tab.key, title);
          onEdit(null);
        }}
      />
    );
  }

  return (
    <div className={`tab${active ? " tab--active" : ""}`}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="tab__label"
        onClick={() => {
          onSelect(tab.key);
        }}
        onDoubleClick={() => {
          onEdit(tab.key);
        }}
      >
        <span className={`tab__dot tab__dot--${tab.status}`} aria-hidden="true" />
        {tab.title}
      </button>
      <button
        type="button"
        className="tab__close"
        aria-label={`close ${tab.title}`}
        onClick={() => {
          onClose(tab.key);
        }}
      >
        ✕
      </button>
    </div>
  );
}

interface RenameFieldProps {
  readonly tab: TerminalTab;
  onCommit: (title: string) => void;
}

/**
 * Inline rename. Blur commits and Escape cancels, so a click elsewhere keeps
 * what was typed rather than discarding it — the tab strip is not a form.
 */
function RenameField({ tab, onCommit }: RenameFieldProps) {
  const [draft, setDraft] = useState(tab.title);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.select();
  }, []);

  return (
    <input
      ref={field}
      className="tab__rename"
      type="text"
      value={draft}
      aria-label={`rename ${tab.title}`}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit(draft);
        } else if (event.key === "Escape") {
          onCommit(tab.title);
        }
      }}
    />
  );
}
