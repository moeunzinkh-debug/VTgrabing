import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

// Every test file gets a fresh, fully migrated D1 database.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// D1 is isolated per test by the Workers pool, R2 is not: empty the bucket so a
// leftover object key from a previous test can never collide.
beforeEach(async () => {
  const listed = await env.FILES.list({ limit: 1000 });
  await Promise.all(listed.objects.map((object) => env.FILES.delete(object.key)));
});
