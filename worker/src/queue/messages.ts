import { z } from 'zod';

export const queueMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job.init'),
    jobId: z.string().min(1),
  }),
  z.object({
    type: z.literal('job.item'),
    jobId: z.string().min(1),
    jobItemId: z.string().min(1),
    attempt: z.number().int().min(1).max(10).default(1),
    /** Number of times the message was re-queued by the concurrency limiter. */
    throttled: z.number().int().min(0).max(10_000).default(0),
  }),
  z.object({
    type: z.literal('job.finalize'),
    jobId: z.string().min(1),
  }),
]);

export type QueueMessage = z.infer<typeof queueMessageSchema>;

export interface QueueSendOptions {
  delaySeconds?: number;
}

/** Send queue messages, respecting the 100 messages / batch limit of Queues. */
export async function sendMessages(
  queue: Queue<QueueMessage>,
  messages: QueueMessage[],
  options: QueueSendOptions & { batchSize?: number } = {},
): Promise<number> {
  const batchSize = Math.min(100, Math.max(1, options.batchSize ?? 100));
  let sent = 0;
  for (let offset = 0; offset < messages.length; offset += batchSize) {
    const slice = messages.slice(offset, offset + batchSize).map((message) => ({
      body: message,
      ...(options.delaySeconds ? { delaySeconds: options.delaySeconds } : {}),
    }));
    await queue.sendBatch(slice);
    sent += slice.length;
  }
  return sent;
}
