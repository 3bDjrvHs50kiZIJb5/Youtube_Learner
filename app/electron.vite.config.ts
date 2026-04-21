import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron',
      rollupOptions: {
        input: { main: resolve(__dirname, 'electron/main.ts') },
      },
    },
    resolve: {
      alias: { '@main': resolve(__dirname, 'electron') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron',
      emptyOutDir: false,
      rollupOptions: {
        input: { preload: resolve(__dirname, 'electron/preload.ts') },
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src') },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') },
      },
    },
    server: {
      port: 5173,
    },
  },
});
