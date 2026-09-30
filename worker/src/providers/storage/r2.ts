/**
 * Streaming writer for R2.
 *
 * Cloudflare Workers have a 128 MB memory ceiling and R2 multipart uploads require
 * every part but the last to be at least 5 MiB, so the writer buffers ~8 MiB chunks
 * and streams them out instead of holding a whole object in memory.
 */

export const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MiB
export const PART_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB (>= R2 5 MiB minimum)
const MAX_PARTS = 10_000; // R2 hard limit

export interface WrittenObject {
  key: string;
  size: number;
  etag: string | null;
  parts: number;
  multipart: boolean;
}

interface PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  contentType?: string;
}

/** Read a stream to the end, buffering at most `limit` bytes. */
async function readFully(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ chunks: Uint8Array[]; size: number; complete: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { chunks, size, complete: true };
      if (value && value.byteLength > 0) {
        chunks.push(value);
        size += value.byteLength;
      }
      if (size >= limit) return { chunks, size, complete: false };
    }
  } finally {
    reader.releaseLock();
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Write `stream` to `bucket` under `key`.
 * Small objects use a single `put()`; larger ones are streamed with a multipart
 * upload so peak memory stays around one part (8 MiB).
 */
export async function writeStreamToR2(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  options: PutOptions = {},
): Promise<WrittenObject> {
  const httpMetadata: R2HTTPMetadata = {
    ...(options.httpMetadata ?? {}),
    ...(options.contentType ? { contentType: options.contentType } : {}),
  };

  // Buffer the first (up to) PART_SIZE bytes: if the stream ends inside it we can
  // skip multipart entirely and do one atomic put().
  const reader = stream.getReader();
  const firstChunks: Uint8Array[] = [];
  let firstSize = 0;
  let streamDone = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      streamDone = true;
      break;
    }
    if (value && value.byteLength > 0) {
      firstChunks.push(value);
      firstSize += value.byteLength;
    }
    if (firstSize >= PART_SIZE_BYTES) break;
  }

  if (streamDone) {
    const body = concat(firstChunks, firstSize);
    reader.releaseLock();
    const object = await bucket.put(key, body, {
      httpMetadata: Object.keys(httpMetadata).length > 0 ? httpMetadata : undefined,
      customMetadata: options.customMetadata,
    });
    return {
      key,
      size: body.byteLength,
      etag: object?.etag ?? null,
      parts: 1,
      multipart: false,
    };
  }
  // Keep the lock: `remaining` below keeps reading from the same reader.

  // Rebuild a stream that continues where the buffered bytes stopped.
  const remaining = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const upload = await bucket.createMultipartUpload(key, {
    httpMetadata: Object.keys(httpMetadata).length > 0 ? httpMetadata : undefined,
    customMetadata: options.customMetadata,
  });

  const parts: R2UploadedPart[] = [];
  let partNumber = 1;
  let total = 0;

  try {
    // First part is what we already buffered.
    parts.push(await upload.uploadPart(partNumber, concat(firstChunks, firstSize)));
    total += firstSize;
    partNumber += 1;

    for (;;) {
      if (partNumber > MAX_PARTS) {
        throw new Error('R2 multipart upload exceeded the maximum number of parts');
      }
      const { chunks, size, complete } = await readFully(remaining, PART_SIZE_BYTES);
      if (size > 0) {
        parts.push(await upload.uploadPart(partNumber, concat(chunks, size)));
        total += size;
        partNumber += 1;
      }
      if (complete) break;
    }

    const object = await upload.complete(parts);
    return {
      key,
      size: total,
      etag: object?.etag ?? null,
      parts: parts.length,
      multipart: true,
    };
  } catch (error) {
    await upload.abort();
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The lock was already released (single put path) - nothing to do.
    }
  }
}

/** Wrap a fixed payload in a ReadableStream of `chunkSize` byte chunks. */
export function toChunkedStream(bytes: Uint8Array, chunkSize = 256 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}
