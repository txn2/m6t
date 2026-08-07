import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DIFF_LINES } from "../lib/pipeline";
import { DiffView } from "./DiffView";

afterEach(cleanup);

/** The rendered lines, with the class of change the viewer gave each one. */
function rendered(): { kind: string | null; text: string }[] {
  return [...screen.getByLabelText("Cluster diff").querySelectorAll(".diff__line")].map(
    (line) => ({ kind: line.getAttribute("data-kind"), text: line.textContent ?? "" }),
  );
}

describe("rendering a cluster diff", () => {
  it("marks each line with what it is", () => {
    render(<DiffView output={"--- LIVE\n   name: api\n-  replicas: 2\n+  replicas: 3\n"} />);

    expect(rendered()).toEqual([
      { kind: "meta", text: "--- LIVE" },
      { kind: "context", text: "   name: api" },
      { kind: "removed", text: "-  replicas: 2" },
      { kind: "added", text: "+  replicas: 3" },
    ]);
  });

  // The sign is kept as well as the colour, so the diff survives being copied
  // out of the window as text and is readable to someone who cannot tell the
  // two colours apart.
  it("keeps the sign on every changed line", () => {
    render(<DiffView output={"-gone\n+new\n"} />);

    const text = rendered().map((line) => line.text);
    expect(text).toEqual(["-gone", "+new"]);
  });

  // A zero-height line collapses the row and breaks the alignment of
  // everything under it.
  it("gives a blank line something to occupy its row", () => {
    render(<DiffView output={"+a\n\n+b\n"} />);

    expect(rendered()[1].text).toBe(" ");
  });

  // A viewer that truncated without admitting it would show a short diff for a
  // large change, which is the most dangerous kind of preview there is.
  it("says how many lines it left out", () => {
    const output = `${Array.from({ length: MAX_DIFF_LINES + 3 }, () => "+x").join("\n")}\n`;

    render(<DiffView output={output} />);

    expect(rendered()).toHaveLength(MAX_DIFF_LINES);
    expect(screen.getByText(/4 more lines not shown/)).toBeDefined();
  });

  it("says nothing about truncation when nothing was truncated", () => {
    render(<DiffView output={"+a\n"} />);

    expect(screen.queryByText(/not shown/)).toBeNull();
  });
});
