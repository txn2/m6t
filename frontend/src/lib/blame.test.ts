import { describe, expect, it } from "vitest";
import {
  BLAME_LABEL_WIDTH,
  UNCOMMITTED_LABEL,
  blameLabel,
  blameTooltip,
  commitAt,
  formatDay,
  formatMoment,
  initials,
} from "./blame";
import type { Blame, BlameCommit } from "./git";

const commit = (over: Partial<BlameCommit> = {}): BlameCommit => ({
  sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  author: "Craig Johnston",
  // 2026-08-06 09:30 local, whatever zone the test runs in.
  authorTime: Math.floor(new Date(2026, 7, 6, 9, 30).getTime() / 1000),
  summary: "Give editor tabs a context menu",
  uncommitted: false,
  ...over,
});

const blame = (commits: BlameCommit[], lines: number[]): Blame => ({ commits, lines });

/** A string's length in glyphs, which is what a monospace column is measured
 * in — `.length` counts a surrogate pair twice. */
const glyphs = (text: string): number => [...text].length;

describe("commitAt", () => {
  const two = blame([commit({ author: "First" }), commit({ author: "Second" })], [0, 1, 0]);

  it("resolves a line to the commit its index names", () => {
    expect(commitAt(two, 1)?.author).toBe("First");
    expect(commitAt(two, 2)?.author).toBe("Second");
    expect(commitAt(two, 3)?.author).toBe("First");
  });

  it("has nothing for a line past the end of the blame", () => {
    // The buffer growing under a blame read before the edit — the case that
    // makes this a guard rather than a formality.
    expect(commitAt(two, 4)).toBeNull();
  });

  it("has nothing for a line before the first", () => {
    expect(commitAt(two, 0)).toBeNull();
  });

  it("has nothing for a line the blame did not cover", () => {
    expect(commitAt(blame([commit()], [-1]), 1)).toBeNull();
  });

  it("has nothing for an index that names no commit", () => {
    expect(commitAt(blame([commit()], [7]), 1)).toBeNull();
  });
});

describe("initials", () => {
  it("takes the first and last of a full name", () => {
    expect(initials("Craig Johnston")).toBe("CJ");
    expect(initials("Ada Byron King")).toBe("AK");
  });

  it("takes two letters from a single-word name", () => {
    expect(initials("cjimti")).toBe("CJ");
  });

  it("takes what there is of a one-letter name", () => {
    expect(initials("x")).toBe("X");
  });

  it("answers something for a name git reported as empty", () => {
    expect(initials("")).toBe("??");
    expect(initials("   ")).toBe("??");
  });

  it("splits on any run of whitespace", () => {
    expect(initials("  Craig   Johnston  ")).toBe("CJ");
  });

  it("takes whole code points, not halves of them", () => {
    // A name whose first character is outside the BMP. charAt would return a
    // lone surrogate here, which renders as a replacement glyph.
    expect(initials("𝒜da Lovelace")).toBe("𝒜L");
  });
});

describe("blameLabel", () => {
  it("is the author's initials and the date they wrote it", () => {
    expect(blameLabel(commit())).toBe("CJ 2026-08-06");
  });

  it("names nobody for a line that is in no commit", () => {
    expect(blameLabel(commit({ uncommitted: true, author: "Not Committed Yet" }))).toBe(
      UNCOMMITTED_LABEL,
    );
  });

  // The column is sized from BLAME_LABEL_WIDTH, in a monospace gutter, so the
  // label has to actually be that many characters — a longer one is truncated
  // to an ellipsis rather than wrapped, which is how the date loses its day.
  //
  // Counted in code points rather than in `.length`: an astral initial is one
  // glyph in the column and two UTF-16 units in the string, and the column is
  // measured in glyphs.
  it("is exactly the width the column is sized for", () => {
    for (const author of ["Craig Johnston", "Ada Byron King", "cjimti", ""]) {
      expect(glyphs(blameLabel(commit({ author })))).toBe(BLAME_LABEL_WIDTH);
    }
  });

  it("never exceeds that width, whatever git reported", () => {
    for (const author of ["Wolfgang Amadeus Mozart", "𝒜da Lovelace", "x", "  "]) {
      expect(glyphs(blameLabel(commit({ author })))).toBeLessThanOrEqual(BLAME_LABEL_WIDTH);
    }
    expect(glyphs(UNCOMMITTED_LABEL)).toBeLessThanOrEqual(BLAME_LABEL_WIDTH);
  });

  it("drops the date when git reported no readable time", () => {
    expect(blameLabel(commit({ authorTime: 0 }))).toBe("CJ");
  });
});

describe("blameTooltip", () => {
  it("carries the name, the moment, the short sha and the subject", () => {
    expect(blameTooltip(commit())).toBe(
      "Craig Johnston · 2026-08-06 09:30 · a1b2c3d · Give editor tabs a context menu",
    );
  });

  it("omits a subject git did not report rather than leaving a gap", () => {
    expect(blameTooltip(commit({ summary: "" }))).toBe(
      "Craig Johnston · 2026-08-06 09:30 · a1b2c3d",
    );
  });

  it("says what an uncommitted line is instead of naming a commit", () => {
    const tip = blameTooltip(commit({ uncommitted: true }));

    expect(tip).toContain("Not committed yet");
    expect(tip).not.toContain("a1b2c3d");
  });
});

describe("formatDay", () => {
  it("is the date's own local fields, zero-padded", () => {
    expect(formatDay(new Date(2026, 7, 6))).toBe("2026-08-06");
    expect(formatDay(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(formatDay(new Date(1999, 11, 31))).toBe("1999-12-31");
  });

  it("reports the day the author saw, not UTC's", () => {
    // 11pm local on the 6th is the 7th in UTC east of Greenwich. toISOString
    // would report the wrong day for half the world; this must not.
    const late = new Date(2026, 7, 6, 23, 30);

    expect(formatDay(late)).toBe("2026-08-06");
  });
});

describe("formatMoment", () => {
  it("adds a zero-padded 24-hour time to the day", () => {
    expect(formatMoment(new Date(2026, 7, 6, 9, 5))).toBe("2026-08-06 09:05");
    expect(formatMoment(new Date(2026, 7, 6, 23, 59))).toBe("2026-08-06 23:59");
  });
});
