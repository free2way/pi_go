import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "localhost",
    port: 5173,
    proxy: {
      "/api": "http://localhost:3100",
    },
  },
});
