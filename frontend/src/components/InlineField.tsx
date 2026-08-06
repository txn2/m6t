import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * The file tree's inline text fields: naming a new entry, and renaming an
 * existing one. Both stand in for a row rather than opening a dialog.
 *
 * Its own module because FileTree.tsx is at its line budget and this pair is
 * the part of it that knows nothing about trees — only about a depth to
 * indent to and two callbacks.
 */

interface CreateRowProps {
  readonly depth: number;
  readonly isDir: boolean;
  readonly error: string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

export function CreateRow({ depth, isDir, error, onCommit, onCancel }: CreateRowProps) {
  return (
    <InlineField
      depth={depth}
      initial=""
      ariaLabel={isDir ? "new folder name" : "new file name"}
      placeholder={isDir ? "folder name" : "file name"}
      error={error}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

interface InlineFieldProps {
  readonly depth: number;
  readonly initial: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly error: string | null;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/**
 * A single text field standing in for a row: new-entry naming and rename
 * both edit a name in place rather than opening a separate dialog.
 *
 * Escape cancels; losing focus also cancels rather than committing, which is
 * the opposite of the terminal tab strip's rename field (TerminalTabs.tsx) —
 * deliberately, because creating or renaming a file is a filesystem write a
 * stray click should not trigger, where renaming a tab label is not.
 */
export function InlineField({ depth, initial, ariaLabel, placeholder, error, onCommit, onCancel }: InlineFieldProps) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  return (
    <div className="tree__row tree__row--editing" style={{ "--depth": depth } as CSSProperties}>
      <input
        ref={field}
        type="text"
        className="tree__inline-field"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => { setValue(event.target.value); }}
        onClick={(event) => { event.stopPropagation(); }}
        onKeyDown={(event) => {
          // Every keystroke stops here: without this, an arrow key typed
          // while naming a file would also move the tree's cursor, and
          // Enter would both commit the field and activate whatever row the
          // cursor was already on — the container's own handleKeyDown must
          // never see a key meant for this field.
          event.stopPropagation();
          if (event.key === "Enter" && value.trim() !== "") {
            onCommit(value.trim());
          } else if (event.key === "Escape") {
            onCancel();
          }
        }}
        onBlur={onCancel}
      />
      {error !== null && <span className="tree__inline-error">{error}</span>}
    </div>
  );
}
