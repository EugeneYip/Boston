/**
 * HMR-free verification server.
 *
 * The shared dev server on :5273 full-reloads every tab whenever any agent saves a
 * file. With several agents working at once that makes screenshots and frame timings
 * unusable -- five back-to-back measureFps(2) calls on an unchanged scene have
 * returned 19.9 / 9.8 / 10.3 / 8.3 / 5.4. Agents were each improvising their own
 * private server on a random port; this makes it one documented facility.
 *
 * Serves the same live source tree, so it always reflects what is on disk.
 * Reload manually to pick up changes.
 */
export default {
  configFile: false,
  root: '.',
  server: {
    port: 5290,
    strictPort: true,
    host: '127.0.0.1',
    hmr: false,
    watch: { ignored: ['**/*'] },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
};
