import { defineConfig } from 'vite';

// Bundles the single page frontend into ./dist, which wrangler serves as static assets.
export default defineConfig({
  root: 'src/frontend',
  base: './',
  publicDir: false,
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // `npm run dev:client` proxies API traffic to `wrangler dev`.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
