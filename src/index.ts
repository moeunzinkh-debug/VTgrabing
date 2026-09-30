import { Repository } from './db/repository';
import type { Env } from './env';
import { runMaintenance } from './jobs/orchestrator';
import { handleQueue } from './queue/consumer';
import type { QueueMessage } from './queue/messages';
import { app } from './routes/api';

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
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      const storageReady = Boolean(env.DB && env.FILES && env.JOB_QUEUE);
      if (!storageReady && pathname !== '/api/health') {
        return Response.json(
          {
            ok: false,
            error: {
              code: 'storage_not_configured',
              message: 'D1 / R2 / Queue bindings are not configured on this Worker.',
            },
          },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        );
      }
      return app.fetch(request, env, ctx);
    }
    return serveFrontend(request, env);
  },

  async queue(batch, env) {
    if (!env.DB) return;
    await handleQueue(batch, env);
  },

  async scheduled(_event, env) {
    if (!env.DB) return;
    const result = await runMaintenance(env, new Repository(env));
    console.log(
      `[vtgrab] maintenance: polled=${result.polled} completed=${result.completed} failed=${result.failed}`,
    );
  },
};

export default worker;
