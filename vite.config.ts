import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
      '/health': { target: 'http://127.0.0.1:3000' },
    },
  },
  build: { outDir: '../dist/ui', emptyOutDir: true },
});
