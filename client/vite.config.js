import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/InfluenceX/',
  server: {
    proxy: {
      '/InfluenceX/api': 'http://localhost:8080'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split heavy charting library into its own chunk — only loaded by Data page
          recharts: ['recharts'],
          // React core + router as a stable chunk
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
