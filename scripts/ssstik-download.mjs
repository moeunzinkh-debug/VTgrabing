import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { isAllowedMediaHost, unwrapMediaUrl } from './lib/ssstik-media.mjs';

// SSSTik hands out either a redirecting proxy URL or one whose real target is
// base64-encoded into the path, so unwrap first and validate *the decoded* host.
// Never fetch an arbitrary address that appeared in third-party HTML (SSRF).
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export function allowedMediaUrl(raw) {
  const { url: unwrapped, decoded } = unwrapMediaUrl(raw);
  const url = new URL(unwrapped);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !isAllowedMediaHost(host)) {
    throw new Error(`Media host is not on the probe allow-list: ${host}${decoded ? ' (decoded from an SSSTik wrapper)' : ''}`);
  }
  return url;
}

async function fetchMedia(raw, fetchImpl, signal) {
  let url = allowedMediaUrl(raw);
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { accept: 'video/mp4,application/octet-stream;q=0.9', referer: 'https://ssstik.io/' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || hop === 5) throw new Error('Media redirected too many times or without a Location header.');
      url = allowedMediaUrl(new URL(location, url).href);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Media host returned HTTP ${response.status}.`);
    }
    return response;
  }
  throw new Error('Too many media redirects.');
}

/**
 * Only the first video link is downloaded: one TikTok post = one MP4 file.
 * Reject HTML, non-MP4, truncation, oversize responses and unsafe redirects.
 * Bytes stream to an exclusive .part file, renamed only on success.
 */
export async function downloadOneVideo(results, {
  fetchImpl = fetch,
  outputDir = 'downloads',
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 180_000,
} = {}) {
  const entry = results.find((result) => result.kind === 'video');
  if (!entry) throw new Error('SSSTik did not return a video link for this post.');
  // Reject an unknown address BEFORE creating files or contacting it.
  allowedMediaUrl(entry.url);
  const response = await fetchMedia(entry.url, fetchImpl, AbortSignal.timeout(timeoutMs));
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const length = response.headers.get('content-length');
  const expectedBytes = length === null ? null : Number(length);
  if (type && type !== 'video/mp4' && type !== 'application/octet-stream') {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Refusing non-MP4 response (${type}).`);
  }
  if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 8 || expectedBytes > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Invalid or oversized media Content-Length.');
  }
  if (!response.body) throw new Error('Media response had no body.');

  await mkdir(outputDir, { recursive: true });
  const filename = `ssstik-${randomUUID()}.mp4`;
  const destination = join(outputDir, filename);
  const temporary = `${destination}.part`;
  let bytes = 0;
  let prefix = Buffer.alloc(0);
  let verified = false;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new Error(`Media exceeded ${maxBytes} bytes; partial file removed.`));
      if (!verified) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 8) return callback();
        // MP4 ISO BMFF begins with a 32-bit box length followed by "ftyp".
        if (prefix.toString('ascii', 4, 8) !== 'ftyp') return callback(new Error('Media response is not an MP4 file.'));
        verified = true;
        this.push(prefix);
        prefix = Buffer.alloc(0);
      } else {
        this.push(chunk);
      }
      callback();
    },
    flush(callback) {
      if (!verified) return callback(new Error('Media response is too short to be an MP4 file.'));
      if (expectedBytes !== null && bytes !== expectedBytes) return callback(new Error('Media response ended before its advertised length.'));
      callback();
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temporary, { flags: 'wx' }));
    await rename(temporary, destination);
    return { path: destination, bytes };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
