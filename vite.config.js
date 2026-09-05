/**
 * GitHub Pages serves this repository as a PROJECT site, below `/Boston/`, so the
 * production build needs a base prefix that local development must not have.
 *
 * `actions/configure-pages` publishes that prefix as its `base_path` output and the
 * workflow passes it in as BASE_PATH, so the repository name is never hardcoded here
 * and a rename or a move to a user site needs no change to this file. Unset -- which
 * is every local invocation -- means `/`, so `npm run dev`, `npm run preview` and the
 * HMR-free :5290 verify server (which sets `configFile: false` and so never reads
 * this file at all) all stay at the root exactly as AGENTS.md documents.
 *
 * To reproduce the deployed layout locally:
 *   BASE_PATH=/Boston/ npm run build && BASE_PATH=/Boston/ npm run preview
 */
const rawBase = process.env.BASE_PATH || '/';
const base = rawBase.endsWith('/') ? rawBase : rawBase + '/';

export default {
  base,
  server: { port: 5273, strictPort: true, host: '127.0.0.1' },
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
};
