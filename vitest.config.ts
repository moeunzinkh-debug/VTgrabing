import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Mirrors the production bindings without the static assets directory so the
      // suite never depends on a client build.
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          // Secrets, provided the same way `wrangler secret put` would in prod.
          DOWNLOAD_CALLBACK_SECRET: 'test-callback-secret',
          SOURCE_API_TOKEN: 'test-source-token',
          DOWNLOAD_SERVICE_TOKEN: 'test-service-token',
          // Applied in test/setup.ts through applyD1Migrations().
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['test/**/*.test.ts'],
  },
});
