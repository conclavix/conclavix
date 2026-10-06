import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3300' },
  },
  test: {
    environment: 'jsdom',
    server: { deps: { inline: ['vuetify'] } },
  },
});
