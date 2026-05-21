import { defineConfig } from 'vite';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'widget-stats': resolve(__dirname, 'widgets/stats.html'),
        'widget-plans': resolve(__dirname, 'widgets/plans.html'),
        'widget-active-plans': resolve(__dirname, 'widgets/active-plans.html'),
        'widget-tokens': resolve(__dirname, 'widgets/tokens.html'),
      },
    },
  },
});
