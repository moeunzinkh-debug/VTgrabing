import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPageToken, parseResults, probeSsstik, validateTikTokUrl } from './probe-ssstik.mjs';

const VIDEO = 'https://www.tiktok.com/@creator/video/7300000000000000001';
const html = (body, init = {}) => new Response(body, { headers: { 'content-type': 'text/html', ...init.headers }, ...init });

test('accepts only HTTPS TikTok videos and short links, before any fetch', async () => {
  assert.equal(validateTikTokUrl(VIDEO), VIDEO);
  assert.equal(validateTikTokUrl('https://vm.tiktok.com/ZA1/'), 'https://vm.tiktok.com/ZA1/');
  for (const url of [
    'http://www.tiktok.com/@a/video/7300000000000000001',
    'https://tiktok.com.evil.invalid/@a/video/7300000000000000001',
    'https://tiktok.com@169.254.169.254/latest/meta-data',
    'https://www.tiktok.com/@creator',
    'https://www.tiktok.com:444/@a/video/7300000000000000001',
  ]) assert.throws(() => validateTikTokUrl(url));
  let called = false;
  await assert.rejects(probeSsstik('https://127.0.0.1/private', { fetchImpl: () => { called = true; } }));
  assert.equal(called, false);
});

test('reads two historic token spellings but not a missing/challenge token', () => {
  assert.equal(extractPageToken("<script>s_tt = 'Mabc1234';</script>"), 'Mabc1234');
  assert.equal(extractPageToken("<script>window.cfg={tt:'OtherToken12'}</script>"), 'OtherToken12');
  assert.equal(extractPageToken('<h1>Verify you are human</h1>'), null);
});

test('extracts only named media links, with escaped URL decoding and safe scheme', () => {
  const links = parseResults(`
    <a href="https://ssstik.io/redirect?x=1&amp;y=2" class="button without_watermark">MP4</a>
    <a class='music' href='https://media.example.org/track.m4a'>Audio</a>
    <a class="without_watermark" href="javascript:alert(1)">bad</a>
    <a class="music" href="http://169.254.169.254/a">bad</a>
    <a href="https://example.com/ads">ad</a>
    <a class="without_watermark" href="https://ssstik.io/redirect?x=1&amp;y=2">duplicate</a>
  `);
  assert.deepEqual(links, [
    { kind: 'video', url: 'https://ssstik.io/redirect?x=1&y=2' },
    { kind: 'audio', url: 'https://media.example.org/track.m4a' },
  ]);
});

test('GET homepage, retain ephemeral first-party cookie, POST the URL and public token; no download', async () => {
  const calls = [];
  const results = await probeSsstik(VIDEO, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return html("<script>s_tt = 'ExampleToken12'</script>", { headers: { 'set-cookie': 'session=sample; Path=/; HttpOnly' } });
      if (calls.length === 2) return html('<a class="without_watermark" href="https://ssstik.io/a.mp4">MP4</a><a class="music" href="https://ssstik.io/b.m4a">Audio</a>');
      throw new Error('unexpected download');
    },
  });
  assert.deepEqual(calls.map((call) => [call.url, call.options.method, call.options.redirect]), [
    ['https://ssstik.io/', 'GET', 'manual'],
    ['https://ssstik.io/abc?url=dl', 'POST', 'manual'],
  ]);
  assert.equal(calls[1].options.headers.cookie, 'session=sample');
  assert.equal(calls[1].options.headers['hx-request'], 'true');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1].options.body)), {
    id: VIDEO, locale: 'en', tt: 'ExampleToken12',
  });
  assert.deepEqual(results, [
    { kind: 'video', url: 'https://ssstik.io/a.mp4' },
    { kind: 'audio', url: 'https://ssstik.io/b.m4a' },
  ]);
});

test('stops on challenges, redirects, non-HTML, missing media and oversized responses', async () => {
  const fetchTwice = (second) => async (url) => url.endsWith('/abc?url=dl') ? second : html("tt:'ExampleToken12'");
  await assert.rejects(probeSsstik(VIDEO, { fetchImpl: async () => html('<h1>captcha</h1>') }), /token/);
  await assert.rejects(probeSsstik(VIDEO, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https:\/\/evil.example/' } }) }), /redirected/);
  await assert.rejects(probeSsstik(VIDEO, { fetchImpl: fetchTwice(html('blocked', { status: 403 })) }), /403/);
  await assert.rejects(probeSsstik(VIDEO, { fetchImpl: fetchTwice(html('<a href="https://ssstik.io/ads">ad</a>')) }), /did not return/);
  await assert.rejects(probeSsstik(VIDEO, { fetchImpl: fetchTwice(new Response('{}', { headers: { 'content-type': 'application/json' } })) }), /content type/);
  await assert.rejects(probeSsstik(VIDEO, { fetchImpl: fetchTwice(html('x'.repeat(1024 * 1024 + 1))) }), /1 MiB/);
});
