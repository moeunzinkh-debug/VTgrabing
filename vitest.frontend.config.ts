import { defineConfig } from 'vitest/config';

// The frontend is DOM code, so it is tested in a Node + jsdom environment
// (the main suite runs inside the Workers runtime and has no DOM).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test-frontend/**/*.test.ts'],
    css: false,
    testTimeout: 30_000,
  },
});
