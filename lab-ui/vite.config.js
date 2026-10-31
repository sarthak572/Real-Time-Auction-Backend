import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development: `npm run dev:ui` serves the page on :5173 and forwards /api to the control server on :4000.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4000' } },
});
