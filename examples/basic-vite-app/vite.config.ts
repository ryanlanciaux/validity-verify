import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import validity from '@validity.ai/verify-plugin-vite';

export default defineConfig({
  plugins: [react(), validity()],
});
