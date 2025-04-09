// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/spot_adjuster/', // 👈 replace with the repo name
  plugins: [react()],
});