import { defineConfig } from "vite";

// GitHub Pages serves the site under /<repo>/; CI sets TCS_BASE=/TCS/. Locally it is "/".
export default defineConfig({
  base: process.env["TCS_BASE"] ?? "/",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
  server: { host: true },
});
