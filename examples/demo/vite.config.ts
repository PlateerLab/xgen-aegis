import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@xgen-aegis/core': pkg('core/src/index.ts'),
      '@xgen-aegis/react/aegis.css': pkg('react/src/aegis.css'),
      '@xgen-aegis/react': pkg('react/src/index.ts'),
    },
  },
});
