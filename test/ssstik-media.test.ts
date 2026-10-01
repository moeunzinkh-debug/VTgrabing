import { describe, expect, it } from 'vitest';
import {
  ALL_SIGNALS,
  RATE_LIMIT_COOLDOWN_SECONDS,
  decodeBase64UrlSegment,
  describeSignal,
  isAllowedMediaHost,
  isTikTokOrAltHost,
  parseSsstikSignal,
  signalError,
  unwrapMediaUrl,
} from '../src/providers/download/ssstik-media';

/**
 * Standard-alphabet base64, the spelling SSSTik embeds in its CDN paths.
 * `btoa` (not Buffer) because the suite runs inside workerd.
 */
const b64 = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)));

const SIGNED_TIKTOK_URL =
  'https://p16-amd-va.tiktokcdn.com/tos-maliva-avt-0068/4b9daa970fbe7e58419edf62ff966546' +
  '~tplv-tiktokx-cropcenter-q:100:100:q75.webp?dr=8835&idc=useast5&nonce=26013&s=AWEME_DETAIL&t=223449c4';

describe('decodeBase64UrlSegment', () => {
  it('decodes a payload whose target URL carries a query string', () => {
    // The padding `=` and the `?`/`&` of the decoded URL are exactly why the
    // segment has to be validated as strict base64 before atob() is trusted:
    // a lenient decoder would silently truncate at the first invalid character.
    expect(decodeBase64UrlSegment(b64(SIGNED_TIKTOK_URL))).toBe(SIGNED_TIKTOK_URL);
  });

  it('ignores segments that are not strict base64', () => {
    expect(decodeBase64UrlSegment('dl')).toBeNull();
    expect(decodeBase64UrlSegment('not base64 at all!!')).toBeNull();
    expect(decodeBase64UrlSegment('aHR0cHM6Ly9leGFtcGxlLmNvbS94?y=1')).toBeNull();
    expect(decodeBase64UrlSegment('short')).toBeNull();
  });

  it('ignores base64 that decodes to something other than an HTTPS URL', () => {
    expect(decodeBase64UrlSegment(b64('7435208327249939713'))).toBeNull(); // a bare video id
    expect(decodeBase64UrlSegment(b64('http://v16.tiktokcdn.com/a.mp4'))).toBeNull(); // not HTTPS
    expect(decodeBase64UrlSegment(b64('https://evil.example/a.mp4'))).toBe('https://evil.example/a.mp4'); // caller allow-lists
  });

  it('ignores base64 that is not valid UTF-8 text', () => {
    // 0xff 0xfe … is valid base64 but binary; a fatal TextDecoder must reject it
    // instead of producing mojibake that then fails URL parsing for a worse reason.
    expect(decodeBase64UrlSegment('//7+/v7+/v7+/v7+/v7+')).toBeNull();
  });
});

describe('unwrapMediaUrl', () => {
  it('decodes the ssscdn.io locale/product/base64 shape', () => {
    const wrapped = `https://ssscdn.io/en/ssstik/${b64(SIGNED_TIKTOK_URL)}`;
    expect(unwrapMediaUrl(wrapped)).toEqual({ url: SIGNED_TIKTOK_URL, decoded: true });
  });

  it('decodes the tikcdn.io product/kind/base64 shape', () => {
    const wrapped = `https://tikcdn.io/ssstik/a/${b64(SIGNED_TIKTOK_URL)}`;
    expect(unwrapMediaUrl(wrapped)).toEqual({ url: SIGNED_TIKTOK_URL, decoded: true });
  });

  it('rejoins a payload whose base64 contains "/" and so spans several segments', () => {
    // '/' is in the base64 alphabet, so a long signed URL is split by the URL
    // parser. This is the case a "decode the last path segment" implementation
    // silently gets wrong, so assert on the segment count too.
    const wrapped = `https://ssscdn.io/en/ssstik/${b64(SIGNED_TIKTOK_URL)}`;
    const segments = new URL(wrapped).pathname.split('/').filter(Boolean);
    expect(segments.length).toBeGreaterThan(3);
    expect(unwrapMediaUrl(wrapped)).toEqual({ url: SIGNED_TIKTOK_URL, decoded: true });
  });

  it('prefers the longest payload span, so a wrapper prefix is never decoded', () => {
    const wrapped = `https://ssscdn.io/en/ssstik/${b64(SIGNED_TIKTOK_URL)}`;
    const { url } = unwrapMediaUrl(wrapped);
    expect(url).toBe(SIGNED_TIKTOK_URL);
    expect(url).not.toContain('ssscdn.io');
  });

  it('leaves an opaque proxy path alone so the caller fetches it instead', () => {
    // `/dl/<id>` is not base64; it is a redirect the client has to follow.
    const proxy = 'https://ssscdn.io/dl/9f3k2jd8sl2';
    expect(unwrapMediaUrl(proxy)).toEqual({ url: proxy, decoded: false });
  });

  it('leaves a direct CDN link alone', () => {
    expect(unwrapMediaUrl('https://v16.tiktokcdn.com/video.mp4')).toEqual({
      url: 'https://v16.tiktokcdn.com/video.mp4',
      decoded: false,
    });
  });

  it('never returns a non-HTTPS decode, even if the payload claims one', () => {
    const wrapped = `https://ssscdn.io/en/ssstik/${b64('http://v16.tiktokcdn.com/a.mp4')}`;
    // The decode is rejected, so the wrapper URL itself is handed back and the
    // caller's allow-list + SSRF guard still decides what happens next.
    expect(unwrapMediaUrl(wrapped)).toEqual({ url: wrapped, decoded: false });
  });

  it('throws on a value that is not a URL at all', () => {
    expect(() => unwrapMediaUrl('nonsense')).toThrow(/invalid media URL/);
  });
});

describe('host helpers', () => {
  it('accepts the TikTok/ByteDance CDNs and the SSSTik wrappers, including subdomains', () => {
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
      expect(isAllowedMediaHost(host), host).toBe(true);
    }
  });

  it('rejects everything else, including lookalike suffixes', () => {
    for (const host of ['evil.example', 'notssscdn.io', 'tiktokcdn.com.evil.example', 'localhost', '127.0.0.1']) {
      expect(isAllowedMediaHost(host), host).toBe(false);
    }
  });

  it("recognises TikTok's alternate short-link domain", () => {
    expect(isTikTokOrAltHost('xzcs3zlph.com')).toBe(true);
    expect(isTikTokOrAltHost('vm.tiktok.com')).toBe(true);
    expect(isTikTokOrAltHost('ssstik.io')).toBe(false);
  });
});

describe('parseSsstikSignal', () => {
  it('reads the bare event-name spelling HTMX uses', () => {
    expect(parseSsstikSignal(new Headers({ 'hx-trigger': 'ssssuccess_video' }))).toBe('ssssuccess_video');
    expect(parseSsstikSignal(new Headers({ 'hx-trigger': 'ssslimitexceed' }))).toBe('ssslimitexceed');
  });

  it('reads the JSON spelling, and the first known name out of a list', () => {
    expect(parseSsstikSignal(new Headers({ 'hx-trigger': '{"ssstokenfail":"retry=1"}' }))).toBe('ssstokenfail');
    expect(parseSsstikSignal(new Headers({ 'hx-trigger': 'htmx:afterSwap, ssssuccess_slides' }))).toBe(
      'ssssuccess_slides',
    );
  });

  it('returns null for a missing, unknown or malformed header', () => {
    expect(parseSsstikSignal(new Headers())).toBeNull();
    expect(parseSsstikSignal(new Headers({ 'hx-trigger': 'showMessage' }))).toBeNull();
    expect(parseSsstikSignal(new Headers({ 'hx-trigger': '{not json' }))).toBeNull();
  });
});

describe('signalError', () => {
  it('treats the rate limit as retryable and quotes the cooldown SSSTik asks for', () => {
    const error = signalError('ssslimitexceed');
    expect(error?.retryAfterSeconds).toBe(RATE_LIMIT_COOLDOWN_SECONDS);
    expect(RATE_LIMIT_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(10);
    expect(error?.message).toMatch(/rate-limited/);
  });

  it('treats a rejected page token as retryable (a fresh shell fixes it)', () => {
    expect(signalError('ssstokenfail')?.retryAfterSeconds).toBeUndefined();
    expect(signalError('ssstokenfail')?.message).toMatch(/page token/);
  });

  it('never retries a permanent verdict', () => {
    for (const signal of ['sssinvalidlink', 'sssblockedclient', 'ssssuccess_wmonly', 'ssssuccess_slides'] as const) {
      const error = signalError(signal);
      expect(error, signal).not.toBeNull();
      expect(error?.retryAfterSeconds, signal).toBeUndefined();
    }
  });

  it('gives every known signal a distinct, non-empty explanation', () => {
    const seen = new Set<string>();
    for (const signal of ALL_SIGNALS) {
      const text = describeSignal(signal);
      expect(text.length, signal).toBeGreaterThan(20);
      seen.add(text);
    }
    // Only the two "success but no link present" variants may share wording; a new
    // signal that reuses an existing sentence would hide a distinct backend state.
    expect(seen.size).toBeGreaterThanOrEqual(ALL_SIGNALS.length - 1);
  });
});
