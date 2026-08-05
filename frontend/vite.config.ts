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
  },
});
