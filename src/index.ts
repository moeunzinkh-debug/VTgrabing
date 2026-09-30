import { Repository } from './db/repository';
import type { Env } from './env';
import { runMaintenance } from './jobs/orchestrator';
import { handleQueue } from './queue/consumer';
import type { QueueMessage } from './queue/messages';
import { app } from './routes/api';
import { ensureRuntimeEnv } from './runtime/fallbacks';

/**
 * Serve the Vite single page app from the assets binding.
 * Everything that is not an asset falls back to `index.html` (SPA routing).
 */
async function serveFrontend(request: Request, env: Env): Promise<Response> {
  if (env.ASSETS) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;

    const indexUrl = new URL('/index.html', request.url);
    const index = await env.ASSETS.fetch(
      new Request(indexUrl, { method: 'GET', headers: request.headers }),
    );
    if (index.ok) {
      return new Response(index.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
  }
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

const worker: ExportedHandler<Env, QueueMessage> = {
  async fetch(request, env, ctx) {
    const runtimeEnv = ensureRuntimeEnv(env, ctx, request.url);
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      return app.fetch(request, runtimeEnv, ctx);
    }
    return serveFrontend(request, runtimeEnv);
  },

  async queue(batch, env, ctx) {
    const runtimeEnv = ensureRuntimeEnv(env, ctx);
    await handleQueue(batch, runtimeEnv);
  },

  async scheduled(_event, env, ctx) {
    const runtimeEnv = ensureRuntimeEnv(env, ctx);
    const result = await runMaintenance(runtimeEnv, new Repository(runtimeEnv));
    console.log(
      `[vtgrab] maintenance: polled=${result.polled} completed=${result.completed} failed=${result.failed}`,
    );
  },
};

export default worker;
