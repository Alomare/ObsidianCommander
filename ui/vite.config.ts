import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The server serves the built files from the `ui/` folder beside it, at `/` on both listeners, so paths stay relative.
// `npm run dev` with `?mock=1` needs no server. Without it, /api goes to a running server on COMMANDER_PORT.
const port: string = (globalThis as any).process?.env?.COMMANDER_PORT ?? "17490";

export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: { port: 5190, proxy: { "/api": `http://127.0.0.1:${port}` } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
});
