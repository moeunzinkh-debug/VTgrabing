import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_HOSTS,
  decodeBase64UrlSegment,
  isAllowedMediaHost,
  unwrapMediaUrl,
} from './ssstik-media.mjs';

/** Standard-alphabet base64, the spelling SSSTik embeds in its CDN paths. */
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

/**
 * A realistic signed TikTok CDN URL: regional host, `~tplv-` transform marker and
 * a query string. Long enough that its base64 contains `/`, which is the case a
 * naive "decode the last path segment" implementation silently gets wrong.
 */
const SIGNED =
  'https://p16-amd-va.tiktokcdn.com/tos-maliva-avt-0068/' +
  '4b9daa970fbe7e58419edf62ff966546~tplv-tiktokx-cropcenter-q:100:100:q75.webp' +
  '?dr=8835&idc=useast5&nonce=26013&s=AWEME_DETAIL&t=223449c4';

test('decodes a base64 payload whose target URL carries a query string', () => {
  // The `=` padding and the `?`/`&` of the decoded URL are exactly why the segment
  // must be validated as strict base64 before atob() is trusted: a lenient decoder
  // would silently truncate at the first character it dislikes.
  assert.equal(decodeBase64UrlSegment(b64(SIGNED)), SIGNED);
});

test('ignores segments that are not strict base64', () => {
  assert.equal(decodeBase64UrlSegment('dl'), null);
  assert.equal(decodeBase64UrlSegment('short'), null);
  assert.equal(decodeBase64UrlSegment('not base64 at all!!'), null);
  assert.equal(decodeBase64UrlSegment('aHR0cHM6Ly9leGFtcGxlLmNvbS94?y=1'), null);
});

test('ignores base64 that does not decode to an HTTPS URL', () => {
  assert.equal(decodeBase64UrlSegment(b64('7435208327249939713')), null); // a bare video id
  assert.equal(decodeBase64UrlSegment(b64('http://v16.tiktokcdn.com/a.mp4')), null); // not HTTPS
  assert.equal(decodeBase64UrlSegment(b64('/tos-maliva-v/abc')), null); // a path, not a URL
  // A decoded host is returned even when unknown: allow-listing is the caller's job,
  // so that the refusal can name the host it actually rejected.
  assert.equal(decodeBase64UrlSegment(b64('https://evil.example/a.mp4')), 'https://evil.example/a.mp4');
});

test('ignores base64 that is not valid UTF-8 text', () => {
  // Valid base64, binary payload. A fatal TextDecoder must reject it instead of
  // producing mojibake that then fails URL parsing for a misleading reason.
  assert.equal(decodeBase64UrlSegment('//7+/v7+/v7+/v7+/v7+'), null);
});

test('unwraps the ssscdn.io locale/product/base64 shape', () => {
  assert.deepEqual(unwrapMediaUrl(`https://ssscdn.io/en/ssstik/${b64(SIGNED)}`), {
    url: SIGNED,
    decoded: true,
  });
});

test('unwraps the tikcdn.io product/kind/base64 shape', () => {
  assert.deepEqual(unwrapMediaUrl(`https://tikcdn.io/ssstik/a/${b64(SIGNED)}`), {
    url: SIGNED,
    decoded: true,
  });
});

test('rejoins a payload that "/" in the base64 alphabet split into several segments', () => {
  const wrapped = `https://ssscdn.io/en/ssstik/${b64(SIGNED)}`;
  const segments = new URL(wrapped).pathname.split('/').filter(Boolean);
  // Guard the premise: if the payload ever stops spanning segments, this test
  // would pass for the wrong reason and stop covering the rejoin path.
  assert.ok(segments.length > 3, `expected >3 segments, got ${segments.length}`);
  assert.equal(unwrapMediaUrl(wrapped).url, SIGNED);
});

test('leaves an opaque proxy path alone so the caller fetches it instead', () => {
  // `/dl/<id>` is not base64; it is a redirect the client has to follow.
  assert.deepEqual(unwrapMediaUrl('https://ssscdn.io/dl/9f3k2jd8sl2'), {
    url: 'https://ssscdn.io/dl/9f3k2jd8sl2',
    decoded: false,
  });
});

test('leaves a direct CDN link alone', () => {
  assert.deepEqual(unwrapMediaUrl('https://v16.tiktokcdn.com/video.mp4'), {
    url: 'https://v16.tiktokcdn.com/video.mp4',
    decoded: false,
  });
});

test('never returns a non-HTTPS decode, even if the payload claims one', () => {
  const wrapped = `https://ssscdn.io/en/ssstik/${b64('http://v16.tiktokcdn.com/a.mp4')}`;
  // The decode is rejected, so the wrapper URL is handed back unchanged and the
  // caller's allow-list plus SSRF guard still decides what happens next.
  assert.deepEqual(unwrapMediaUrl(wrapped), { url: wrapped, decoded: false });
});

test('keeps a wrapper query string out of the base64 candidate', () => {
  assert.deepEqual(unwrapMediaUrl('https://ssscdn.io/dl/9f3k2jd8sl2?x=1'), {
    url: 'https://ssscdn.io/dl/9f3k2jd8sl2?x=1',
    decoded: false,
  });
});

test('throws on a value that is not a URL at all', () => {
  assert.throws(() => unwrapMediaUrl('nonsense'), /invalid media URL/);
});

test('accepts the TikTok/ByteDance CDNs and SSSTik wrappers, including subdomains', () => {
  for (const host of [
    'ssscdn.io',
    'tikcdn.io',
    'v16.tiktokcdn.com',
    'p16-amd-va.tiktokcdn.com',
    'v16-web.tiktokcdn-us.com',
    'sf16-ies-music-va.tiktokcdn.com',
    'ibytedtos.com',
    'www.tiktok.com',
  ]) {
    assert.equal(isAllowedMediaHost(host), true, host);
  }
});

test('rejects everything else, including lookalike suffixes', () => {
  for (const host of ['evil.example', 'notssscdn.io', 'tiktokcdn.com.evil.example', 'localhost', '127.0.0.1', '']) {
    assert.equal(isAllowedMediaHost(host), false, host);
  }
});

test('the allow-list covers both wrappers and every regional CDN spelling seen in the wild', () => {
  for (const host of ['ssstik.io', 'ssscdn.io', 'tikcdn.io', 'tiktokcdn-us.com', 'tiktokcdn-eu.com']) {
    assert.ok(MEDIA_HOSTS.includes(host), host);
  }
});

test('decodes the sample captured from SSSTik research verbatim', () => {
  assert.deepEqual(
    unwrapMediaUrl(
      'https://ssscdn.io/en/ssstik/aHR0cHM6Ly93d3cudGlrdG9rLmNvbS9AbWVldm4vcGhvdG8vNzQzNTIwODMyNzI0OTkzOTcxMw==',
    ),
    { url: 'https://www.tiktok.com/@meevn/photo/7435208327249939713', decoded: true },
  );
});
