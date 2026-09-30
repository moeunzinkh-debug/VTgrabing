import { describe, expect, it } from 'vitest';
import { MIN_PART_SIZE_BYTES, PART_SIZE_BYTES, partSizeFor, toChunkedStream, writeStreamToR2 } from '../src/providers/storage/r2';
import { testEnv } from './helpers';

function payload(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

describe('writeStreamToR2', () => {
  it('stores small objects with a single put', async () => {
    const bytes = payload(64 * 1024);
    const result = await writeStreamToR2(
      testEnv.FILES,
      'unit/small.bin',
      toChunkedStream(bytes, 8 * 1024),
      { contentType: 'application/octet-stream' },
    );

    expect(result.multipart).toBe(false);
    expect(result.parts).toBe(1);
    expect(result.size).toBe(bytes.byteLength);
    expect(result.etag).toBeTruthy();

    const stored = await testEnv.FILES.get('unit/small.bin');
    expect(stored).not.toBeNull();
    expect(stored!.size).toBe(bytes.byteLength);
    expect(stored!.httpMetadata?.contentType).toBe('application/octet-stream');
    const roundTrip = new Uint8Array(await stored!.arrayBuffer());
    expect(roundTrip.byteLength).toBe(bytes.byteLength);
    expect(roundTrip[0]).toBe(bytes[0]);
    expect(roundTrip[bytes.byteLength - 1]).toBe(bytes[bytes.byteLength - 1]);
  });

  it('streams objects larger than one part with a multipart upload', async () => {
    // 2.5 parts: forces the multipart path with a short final part.
    const size = Math.floor(PART_SIZE_BYTES * 2.5);
    const bytes = payload(size, 99);
    const result = await writeStreamToR2(
      testEnv.FILES,
      'unit/large.bin',
      toChunkedStream(bytes, 512 * 1024),
      { contentType: 'video/mp4', customMetadata: { jobId: 'job_unit' } },
    );

    expect(result.multipart).toBe(true);
    expect(result.parts).toBe(3);
    expect(result.size).toBe(size);

    const stored = await testEnv.FILES.get('unit/large.bin');
    expect(stored!.size).toBe(size);
    expect(stored!.httpMetadata?.contentType).toBe('video/mp4');
    expect(stored!.customMetadata?.jobId).toBe('job_unit');

    // Byte-for-byte equality across the part boundaries.
    const roundTrip = new Uint8Array(await stored!.arrayBuffer());
    expect(roundTrip.byteLength).toBe(size);
    let mismatch = -1;
    for (let index = 0; index < size; index += 1) {
      if (roundTrip[index] !== bytes[index]) {
        mismatch = index;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  });

  it('clamps the part size to what R2 allows', () => {
    expect(partSizeFor()).toBe(PART_SIZE_BYTES);
    expect(partSizeFor(Number.NaN)).toBe(PART_SIZE_BYTES);
    expect(partSizeFor(0)).toBe(PART_SIZE_BYTES);
    // R2 rejects any part but the last one below 5 MiB.
    expect(partSizeFor(1024)).toBe(MIN_PART_SIZE_BYTES);
    expect(partSizeFor(6 * 1024 * 1024)).toBe(6 * 1024 * 1024);
    expect(partSizeFor(1024 * 1024 * 1024)).toBe(1024 * 1024 * 1024);
  });

  it('honours a caller-supplied part size', async () => {
    // The download path passes GRAB_CHUNK_BYTES through, so one chunk is one part:
    // 12 MiB with the 5 MiB minimum makes three parts, not two 8 MiB ones.
    const size = 12 * 1024 * 1024;
    const bytes = payload(size, 5);
    const result = await writeStreamToR2(
      testEnv.FILES,
      'unit/configured-parts.bin',
      toChunkedStream(bytes, 1024 * 1024),
      { contentType: 'video/mp4', partSizeBytes: 1 }, // below the floor on purpose
    );

    expect(result.multipart).toBe(true);
    expect(result.parts).toBe(3);
    expect(result.size).toBe(size);

    const roundTrip = new Uint8Array(await (await testEnv.FILES.get('unit/configured-parts.bin'))!.arrayBuffer());
    expect(roundTrip.byteLength).toBe(size);
    expect(roundTrip[0]).toBe(bytes[0]);
    expect(roundTrip[size - 1]).toBe(bytes[size - 1]);
  });

  it('handles an empty stream', async () => {
    const result = await writeStreamToR2(
      testEnv.FILES,
      'unit/empty.bin',
      toChunkedStream(new Uint8Array(0)),
    );
    expect(result.size).toBe(0);
    const stored = await testEnv.FILES.get('unit/empty.bin');
    expect(stored!.size).toBe(0);
  });
});
