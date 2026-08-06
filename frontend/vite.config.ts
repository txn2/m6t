import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Wails serves the contents of dist/ from the embedded filesystem, so assets
// must be referenced relatively rather than from the server root.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    // dist is wiped on every build so a renamed asset cannot survive into the
    // embedded filesystem as a stale file. That wipe also takes
    // dist/.gitkeep, which is a TRACKED file — the Go build needs the
    // directory to exist in a fresh clone or `//go:embed all:frontend/dist`
    // will not compile (see .gitignore). public/.gitkeep is the fix: Vite
    // copies publicDir into the output root after emptying it, so the
    // placeholder is restored by the same build that removed it. Without it,
    // every `make dev` and `wails build` leaves a deleted tracked file in
    // `git status`.
    emptyOutDir: true,
    // Every vendored icon (#38) inlines as a data URI rather than becoming a
    // separate file in dist. The default limit is 4 KiB and helm.svg is just
    // over it, which would emit one asset the app has to fetch through the
    // Wails asset server on first paint — for a 4 KiB string that belongs in
    // the bundle. 8 KiB covers the whole set with room to add to it.
    assetsInlineLimit: 8192,
  },
});
