import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedMediaUrl, downloadOneVideo } from './ssstik-download.mjs';
import { probeSsstik } from './probe-ssstik.mjs';

// Minimal byte sequence with an MP4 ftyp box; the downloader checks the signature,
// not the codec validity. Never substitute this fixture for a real TikTok video.
const video = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0, 0]), Buffer.alloc(100, 19)]);
const entry = [{ kind: 'audio', url: 'https://ssstik.io/music.m4a' }, { kind: 'video', url: 'https://ssstik.io/download/video' }];

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'vtgrab-ssstik-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('refuses unknown/unsafe media hosts before attempting network access', async () => {
  for (const url of ['http://ssstik.io/video', 'https://ssstik.io.evil.org/video',
    'https://169.254.169.254/private', 'file:///etc/passwd', 'https://user:pass@ssstik.io/a']) {
    assert.throws(() => allowedMediaUrl(url));
  }
  let called = false;
  await assert.rejects(downloadOneVideo([{ kind: 'video', url: 'https://evil.org/a' }], {
    fetchImpl: () => { called = true; },
  }), /allow-list/);
  assert.equal(called, false);
});

test('one video URL -> one verified MP4 file, following only guarded public HTTPS redirects', async () => {
  await withDir(async (dir) => {
    const calls = [];
    const output = await downloadOneVideo(entry, {
      outputDir: dir,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://v16.tiktokcdn.com/stream.mp4' } });
        return new Response(video, { headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) } });
      },
    });
    assert.deepEqual(calls.map(({ url }) => url), ['https://ssstik.io/download/video', 'https://v16.tiktokcdn.com/stream.mp4']);
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(output.bytes, video.length);
    assert.deepEqual(await readFile(output.path), video);
    assert.deepEqual(await readdir(dir), [output.path.split('/').pop()]);
  });
});

test('single post: get token -> post TikTok URL -> save ONE MP4, not the audio link', async () => {
  await withDir(async (dir) => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push([url, init.method]);
      if (url === 'https://ssstik.io/') return new Response("<script>s_tt = 'ExampleToken12'</script>", { headers: { 'content-type': 'text/html' } });
      if (url === 'https://ssstik.io/abc?url=dl') return new Response('<a class="music" href="https://ssstik.io/audio.m4a">Audio</a><a class="without_watermark" href="https://ssstik.io/download/video">Video</a>', { headers: { 'content-type': 'text/html' } });
      if (url === 'https://ssstik.io/download/video') return new Response(video, { headers: { 'content-type': 'video/mp4' } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const links = await probeSsstik('https://www.tiktok.com/@creator/video/7300000000000000001', { fetchImpl });
    const saved = await downloadOneVideo(links, { fetchImpl, outputDir: dir });
    assert.deepEqual(requests, [
      ['https://ssstik.io/', 'GET'], ['https://ssstik.io/abc?url=dl', 'POST'],
      ['https://ssstik.io/download/video', 'GET'],
    ]);
    assert.deepEqual(await readFile(saved.path), video);
    assert.equal((await readdir(dir)).length, 1);
  });
});

test('refuses unsafe redirects, HTML, too-large, short and truncated files; cleans up', async () => {
  await withDir(async (dir) => {
    await assert.rejects(downloadOneVideo(entry, {
      outputDir: dir,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    }), /allow-list/);
    await assert.rejects(downloadOneVideo(entry, {
      outputDir: dir,
      fetchImpl: async () => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }),
    }), /non-MP4/);
    await assert.rejects(downloadOneVideo(entry, {
      outputDir: dir,
      maxBytes: 32,
      fetchImpl: async () => new Response(video, { headers: { 'content-type': 'video/mp4' } }),
    }), /exceeded/);
    await assert.rejects(downloadOneVideo(entry, {
      outputDir: dir,
      fetchImpl: async () => new Response(Buffer.from('not an MP4'), { headers: { 'content-type': 'video/mp4' } }),
    }), /not an MP4/);
    await assert.rejects(downloadOneVideo(entry, {
      outputDir: dir,
      fetchImpl: async () => new Response(video, { headers: { 'content-type': 'video/mp4', 'content-length': String(video.length + 20) } }),
    }), /advertised length/);
    assert.deepEqual(await readdir(dir), []);
  });
});
