import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1421,
    // if 1421 is busy, use next free port instead of crashing
    strictPort: false,
  },
});
