import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The vendored icon set's two standing claims (#38), gated rather than
 * asserted in a comment.
 *
 * Neither is visible to a rendering test. `Icon.test.tsx` can only see what
 * vitest's dev transform produces, which serves an asset as a URL; whether it
 * ends up inlined in the bundle is a property of `vite build`, and building
 * inside the unit suite to find out would tie one gate to another. Both facts
 * are readable straight off disk instead, which is what these do — the same
 * approach, and for the same reason, as `style.test.ts`.
 *
 * Paths are relative to the working directory, which `make frontend-test` and
 * `npm test` both set to frontend/.
 */
const ICON_DIR = "src/icons/material";
const VITE_CONFIG = "vite.config.ts";

function readFrom(path: string): string {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    throw new Error(
      `${full} does not exist — this test reads from the working directory ` +
        `(${process.cwd()}); run it from frontend/`,
    );
  }
  return readFileSync(full, "utf8");
}

/** Every vendored icon, as [name, bytes]. */
function vendoredIcons(): [string, number][] {
  const dir = resolve(process.cwd(), ICON_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".svg"))
    .map((name) => [name, statSync(resolve(dir, name)).size]);
}

/** `build.assetsInlineLimit` as vite.config.ts sets it. */
function inlineLimit(): number {
  const match = /assetsInlineLimit:\s*(\d+)/.exec(readFrom(VITE_CONFIG));
  if (match === null) {
    throw new Error(
      "vite.config.ts no longer sets build.assetsInlineLimit — without it " +
        "the default is 4096 and helm.svg becomes a separate asset the app " +
        "has to fetch",
    );
  }
  return Number(match[1]);
}

describe("the vendored icon set", () => {
  it("has icons to check", () => {
    // The premise: an empty directory would make every check below pass over
    // nothing at all.
    expect(vendoredIcons().length).toBeGreaterThan(10);
  });

  it("keeps every icon small enough for Vite to inline it", () => {
    const limit = inlineLimit();
    const oversized = vendoredIcons()
      .filter(([, bytes]) => bytes >= limit)
      .map(([name, bytes]) => `${name} (${String(bytes)} bytes)`);

    expect(
      oversized,
      `icons at or over the ${String(limit)}-byte inline limit: ${oversized.join(", ")}. ` +
        "Vite emits these as separate files, so the app fetches them through " +
        "the Wails asset server on first paint. Optimise the artwork or raise " +
        "build.assetsInlineLimit.",
    ).toEqual([]);
  });

  it("ships the upstream licence beside the artwork", () => {
    // The whole basis for vendoring rather than depending: MIT art, copied
    // with its licence. Losing the file would leave the copies unattributed.
    const licence = readFrom(`${ICON_DIR}/LICENSE`);
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Material Extensions");
  });

  it("records where the artwork came from", () => {
    const readme = readFrom(`${ICON_DIR}/README.md`);
    expect(readme).toContain("material-icon-theme");
    expect(readme).toMatch(/version \*\*\d+\.\d+\.\d+\*\*/);
  });
});
