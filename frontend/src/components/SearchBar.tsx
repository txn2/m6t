import { useEffect, useRef, useState } from "react";

/**
 * The find box over a terminal pane, driving xterm's search addon.
 *
 * It reports misses rather than failing silently: in a 10,000-line scrollback
 * "no match" and "match somewhere off screen" look identical otherwise.
 */
export interface SearchBarProps {
  onFind: (query: string, direction: "next" | "previous") => boolean;
  onClose: () => void;
}

export function SearchBar({ onFind, onClose }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [missed, setMissed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const find = (direction: "next" | "previous") => {
    if (query === "") {
      return;
    }
    setMissed(!onFind(query, direction));
  };

  return (
    <div className="search" role="search">
      <input
        ref={input}
        className={`search__input${missed ? " search__input--missed" : ""}`}
        type="text"
        value={query}
        placeholder="find"
        aria-label="find in terminal"
        onChange={(event) => {
          setQuery(event.target.value);
          setMissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            find(event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            onClose();
          }
        }}
      />
      <button
        type="button"
        aria-label="find previous"
        onClick={() => {
          find("previous");
        }}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="find next"
        onClick={() => {
          find("next");
        }}
      >
        ↓
      </button>
      <button type="button" aria-label="close find" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
