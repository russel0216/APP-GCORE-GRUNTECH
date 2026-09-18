import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The dev server talks to the API on 5100; in production the API serves
      // this build from its own origin, so the same relative paths work in both.
      '/api': { target: 'http://localhost:5100', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
