import type { Env as AppEnv } from '../worker/src/env';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

// Make `import { env } from "cloudflare:test"` resolve to VTGrab's binding type,
// without generating a `worker-configuration.d.ts` that could drift from src/env.ts.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      /** Migrations applied in test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
