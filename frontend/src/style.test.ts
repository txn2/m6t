import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet, read from disk.
 *
 * Neither of the two obvious alternatives works here. `import.meta.url` is not
 * a `file:` URL under vitest's jsdom environment, so `fileURLToPath` throws at
 * collection time — which surfaces as "no tests" rather than as a failure, the
 * worst possible outcome for a gate. And `import css from "./style.css?raw"`
 * returns an empty string, because vitest stubs CSS modules unless
 * `test.css` is enabled: every assertion below would then pass over nothing.
 *
 * The path is relative to the working directory, which `make frontend-test`
 * and `npm test` both set to frontend/. The existence check is what turns a
 * wrong cwd into a named failure instead of a silent empty-string pass.
 */
const STYLESHEET = "src/style.css";

function readStylesheet(): string {
  const path = resolve(process.cwd(), STYLESHEET);
  if (!existsSync(path)) {
    throw new Error(
      `${path} does not exist — this test reads the stylesheet relative to the ` +
        `working directory (${process.cwd()}); run it from frontend/`,
    );
  }
  return readFileSync(path, "utf8");
}

const css = readStylesheet();

/**
 * The token ratchet for style.css (#33).
 *
 * The stylesheet this replaced had ten different rem paddings — 0.15, 0.2,
 * 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.75, 1 — which at a 14px root computed to
 * 2.1px through 14px, none on a pixel grid and none related to each other, and
 * five colours written as literal hex beside a palette that already defined
 * them. None of that arrived in one commit; it accumulated one plausible rule
 * at a time. A gate is the only thing that stops it accumulating again, and it
 * belongs here rather than in review because "is 0.35rem the same as the
 * 0.35rem three rules up" is exactly the question a reviewer stops asking on
 * the second page.
 */

/** A `selector { ... }` block, by its opening selector text. */
function blockFor(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`style.css has no ${selector} block`);
  }
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

/** The two blocks where a literal colour is the definition rather than a
 * bypass of it. */
const paletteBlocks = [blockFor(":root"), blockFor(".shell--light")];

/** Everything outside the palette definitions. */
function outsidePalettes(): string {
  return paletteBlocks.reduce((rest, block) => rest.replace(block, ""), css);
}

/**
 * The markdown section, which is exempt from the spacing tokens.
 *
 * Prose spacing scales with the type it surrounds — a heading's margin is a
 * property of that heading's size — so it is expressed in em and pinning it to
 * the chrome's 4px grid would put an h1 and an h3 in the same amount of air.
 * The exemption is a named region rather than a per-property allowance so that
 * widening it is a visible edit to this file.
 */
const MARKDOWN_START = "   Markdown preview";
const MARKDOWN_END = "   Git status: tree badges";

function withoutMarkdown(): string {
  const start = css.indexOf(MARKDOWN_START);
  const end = css.indexOf(MARKDOWN_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      "style.css no longer has the markdown section this exemption names; " +
        "update MARKDOWN_START/MARKDOWN_END or drop the exemption",
    );
  }
  return css.slice(0, start) + css.slice(end);
}

/** Properties whose values must come from the spacing and radius tokens. */
const TOKENISED = [
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  "border-radius",
];

/** Declarations of the tokenised properties, as [property, value] pairs. */
function tokenisedDeclarations(source: string): [string, string][] {
  const found: [string, string][] = [];
  const declaration = /(^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const [, , property, value] = match;
    if (TOKENISED.includes(property)) {
      found.push([property, value.trim()]);
    }
  }
  return found;
}

/** Whether one space-separated atom of a value is allowed. */
function atomIsTokenised(atom: string): boolean {
  return (
    atom === "0" ||
    atom === "auto" ||
    atom === "inherit" ||
    /^var\(--m6t-[a-z0-9-]+\)$/.test(atom)
  );
}

/** A literal length: a number carrying a unit. `0` is not one. */
const RAW_LENGTH = /\d*\.?\d+(px|rem|em|%|vh|vw|ch)\b/;

/**
 * Whether a whole declaration value comes from the tokens.
 *
 * `calc()` gets its own branch because it composes tokens into an expression
 * — the tree's indent is `space-3 + indent * depth` — and splitting that on
 * whitespace would reject the operators. Inside a calc the rule is simply
 * that no literal length appears, which is the same guarantee by a different
 * route.
 */
function valueIsTokenised(value: string): boolean {
  if (value.startsWith("calc(")) {
    return !RAW_LENGTH.test(value);
  }
  return value
    .split(/\s+/)
    .filter((atom) => atom.length > 0)
    .every(atomIsTokenised);
}

describe("the style tokens", () => {
  it("defines its palettes in exactly two places", () => {
    // The test's own premise: if these stop existing, every check below is
    // vacuously true and would report a pass over an untokenised file.
    expect(paletteBlocks[0]).toContain("--m6t-bg");
    expect(paletteBlocks[1]).toContain("--m6t-bg");
  });

  it("has no literal colour outside the palettes", () => {
    const offenders = outsidePalettes().match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];

    expect(
      offenders,
      `literal colours outside :root and .shell--light: ${offenders.join(", ")}. ` +
        "Add a token to both palettes and use it, so light mode cannot be forgotten.",
    ).toEqual([]);
  });

  it("expresses every space and radius as a token", () => {
    const offenders = tokenisedDeclarations(withoutMarkdown())
      .filter(([, value]) => !valueIsTokenised(value))
      .map(([property, value]) => `${property}: ${value}`);

    expect(
      offenders,
      `raw lengths in spacing declarations: ${offenders.join("; ")}. ` +
        "Use a --m6t-space-* or --m6t-radius token; add one if the scale genuinely lacks the step.",
    ).toEqual([]);
  });

  // The gate is worthless if its matcher does not fire. These are the exact
  // shapes the old stylesheet was full of.
  it("catches the shapes it was written for", () => {
    for (const rule of [
      ".a { padding: 0.35rem 0.5rem; }",
      ".a { border-radius: 999px; }",
      ".a { margin: 1px; }",
      // A calc that smuggles a literal in among the tokens.
      ".a { padding-left: calc(var(--m6t-space-3) + 3px); }",
    ]) {
      expect(
        tokenisedDeclarations(rule).every(([, v]) => valueIsTokenised(v)),
        `${rule} should have been rejected`,
      ).toBe(false);
    }
    expect("#e06c75".match(/#[0-9a-fA-F]{3,8}\b/g)).not.toBeNull();
  });

  it("accepts the shapes it is meant to allow", () => {
    const allowed =
      ".a { padding: 0 var(--m6t-space-3); margin: auto; border-radius: var(--m6t-radius); " +
      "padding-left: calc(var(--m6t-space-3) + var(--m6t-indent) * var(--depth, 0)); }";

    expect(
      tokenisedDeclarations(allowed).every(([, v]) => valueIsTokenised(v)),
    ).toBe(true);
  });
});

describe("the IDE metrics", () => {
  it("sizes list rows, section headers and the status bar from one token", () => {
    for (const rule of [".tree__row", ".changes__row", ".statusbar"]) {
      expect(blockFor(rule), `${rule} must be one row token tall`).toContain(
        "height: var(--m6t-row)",
      );
    }
  });

  // The whole point of a fixed row height: a row is 22px whether its name
  // wraps to one word or twenty characters.
  it("gives tree rows no vertical padding to grow with", () => {
    expect(blockFor(".tree__row")).not.toMatch(/padding-top|padding-bottom/);
  });

  it("indents the tree by a token per level rather than a font-relative unit", () => {
    expect(blockFor(".tree__row")).toContain("var(--m6t-indent) * var(--depth");
  });
});
