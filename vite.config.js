export default {
  server: { port: 5273, strictPort: true, host: '127.0.0.1' },
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
};
