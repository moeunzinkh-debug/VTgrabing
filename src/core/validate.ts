import { z } from 'zod';
import { validationFailed } from './errors';
import type { SelectionDescriptor } from '../shared/types';
import { normalizeRange } from './selection';

const httpUrl = z
  .string()
  .trim()
  .min(1, 'url is required')
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url must be a valid http(s) URL');

export const analyzeSchema = z.object({
  url: httpUrl,
  sourceKey: z.string().trim().min(1).max(64).optional(),
  refresh: z.boolean().optional().default(false),
});

const selectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({
    mode: z.literal('ids'),
    episodeIds: z.array(z.string().trim().min(1).max(128)).min(1).max(5000),
  }),
  z
    .object({
      mode: z.literal('range'),
      from: z.coerce.number().int().min(1).max(100000),
      to: z.coerce.number().int().min(1).max(100000),
    })
    // The wire format is flat (`{ mode: 'range', from, to }`), the domain type is nested.
    .transform(({ mode, from, to }) => ({ mode, range: normalizeRange(from, to) })),
]);

export const jobOptionsSchema = z.object({
  quality: z.string().trim().min(1).max(32).optional(),
  container: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .regex(/^[a-z0-9]+$/i, 'container must be alphanumeric')
    .optional(),
  concurrency: z.coerce.number().int().min(1).max(20).optional(),
  prefix: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/, 'prefix must be a safe object key prefix')
    .optional(),
  provider: z.string().trim().min(1).max(64).optional(),
});

export const createJobSchema = z.object({
  seriesId: z.string().trim().min(1).max(128),
  selection: selectionSchema,
  options: jobOptionsSchema.optional(),
});

export const listSeriesSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

export const listJobsSchema = z.object({
  status: z.string().trim().min(1).max(32).optional(),
  seriesId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

export const listFilesSchema = z.object({
  jobId: z.string().trim().min(1).max(128).optional(),
  seriesId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

/** Shape of the payload the authorized download service POSTs back to us. */
export const providerCallbackMetaSchema = z.object({
  providerRef: z.string().trim().min(1).max(256),
  contentType: z.string().trim().min(1).max(255).optional(),
  bytes: z.coerce.number().int().min(0).optional(),
});

export type AnalyzeInput = z.infer<typeof analyzeSchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type JobOptionsInput = z.infer<typeof jobOptionsSchema>;

/** Parse a value, throwing a 400 AppError carrying the zod issues. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    throw validationFailed('Invalid request body', details);
  }
  return result.data;
}

export function parseSelection(input: unknown): SelectionDescriptor {
  return parseOrThrow(selectionSchema, input);
}
