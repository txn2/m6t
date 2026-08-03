import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Wails serves the contents of dist/ from the embedded filesystem, so assets
// must be referenced relatively rather than from the server root.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
