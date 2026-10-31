import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const MASTER = process.env.MASTER_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': MASTER,
      '/socket.io': { target: MASTER, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
  },
});
