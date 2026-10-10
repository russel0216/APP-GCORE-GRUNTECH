import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The dev server talks to the API on 5100 — or on API_PORT, for a worktree
      // whose API runs beside the main tree's; in production the API serves
      // this build from its own origin, so the same relative paths work in both.
      '/api': { target: `http://localhost:${process.env.API_PORT ?? 5100}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
