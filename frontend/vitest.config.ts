import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Unit tests (npm test). Separate from vite.config.ts so the dev-server plugins never run under the test runner.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
