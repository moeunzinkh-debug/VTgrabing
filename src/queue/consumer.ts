import { Repository } from '../db/repository';
import type { Env } from '../env';
import { finalizeJob, runDownloadJobItem, startJob } from '../jobs/orchestrator';
import { queueMessageSchema } from './messages';
import type { QueueMessage } from './messages';

/**
 * Queue consumer. Every message is idempotent: re-delivery (Queues is at-least-once)
 * re-reads the current D1 state before mutating anything.
 */
export async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: Env,
): Promise<void> {
  const repo = new Repository(env);

  for (const message of batch.messages) {
    const parsed = queueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error('[vtgrab] dropping malformed queue message', parsed.error.issues);
      message.ack();
      continue;
    }

    try {
      switch (parsed.data.type) {
        case 'job.init':
          await startJob(env, repo, parsed.data.jobId);
          break;
        case 'job.item':
          await runDownloadJobItem(env, repo, parsed.data);
          break;
        case 'job.finalize':
          await finalizeJob(env, repo, parsed.data.jobId);
          break;
      }
      message.ack();
    } catch (error) {
      console.error(
        `[vtgrab] queue message ${message.id} failed (attempt ${message.attempts}):`,
        error,
      );
      message.retry();
    }
  }
}
