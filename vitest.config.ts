import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts', 'tools/**/test/**/*.test.{ts,mjs}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    passWithNoTests: true,
  },
});
