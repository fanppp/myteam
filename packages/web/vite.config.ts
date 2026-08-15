import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const WEB_PORT = Number(process.env.MYTEAM_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.MYTEAM_API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    host: true,
    proxy: {
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
});
