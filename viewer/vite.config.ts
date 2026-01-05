import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    cors: true,
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    include: [
      'three',
      'web-ifc',
      '@thatopen/ui',
      '@thatopen/ui-obc',
      '@thatopen/components',
      '@thatopen/components-front',
      '@thatopen/fragments',
    ],
  },
});
