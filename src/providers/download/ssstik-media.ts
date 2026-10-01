/**
 * SSSTik media-link unwrapping and backend-signal mapping.
 *
 * Two facts about the public SSSTik result fragment drove this module (see
 * `docs/research/ssstik-frontend-analysis.md`):
 *
 *  1. Its CDN hosts do not always redirect. `ssscdn.io` / `tikcdn.io` frequently
 *     carry the *real*, signed TikTok CDN URL base64-encoded into the last path
 *     segment, so a client that only follows redirects never reaches the bytes.
 *  2. The backend reports what actually happened through the `HX-Trigger`
 *     response header (a custom `<body>` event for HTMX), not through the markup.
 *     Collapsing all of those into "no MP4 link found" makes a batch job of a
 *     whole series impossible to diagnose.
 *
 * Nothing here solves a challenge, mints a token or contacts TikTok: it only
 * interprets a response we already legitimately received.
 */
import { badRequest } from '../../core/errors';

/**
 * Hosts a decoded media URL may live on.
 *
 * The first two are SSSTik's own wrappers; the rest are the TikTok / ByteDance
 * CDNs that the wrappers point at. Signed TikTok URLs are regional, so the list
 * has to cover the regional CDN hostnames or a perfectly valid decode gets
 * rejected for one series and accepted for another.
 */
export const ALLOWED_MEDIA_HOSTS: readonly string[] = [
  'ssstik.io',
  'ssscdn.io',
  'tikcdn.io',
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'tiktokcdnv.com',
  'bytecdn.com',
  'byteicdn.com',
  'bytefcdn.net',
  'byteoversea.com',
  'ibytedtos.com',
  'ibyteimg.com',
  'muscdn.com',
  'mzstatic.com',
];

/** Hosts whose last path segment is base64 of the real target URL. */
const WRAPPER_HOSTS: readonly string[] = ['ssscdn.io', 'tikcdn.io', 'ssstik.io'];

/**
 * A path segment that can only be base64. Requiring the strict alphabet (and
 * rejecting `%`, `?`, `&`, `.`) matters because `atob`/`Buffer.from(…, 'base64')`
 * both happily ignore invalid characters, which would silently truncate a
 * payload whose decoded URL carries a query string.
 */
const BASE64_SEGMENT = /^[A-Za-z0-9+/]+={0,2}$/;

/** Shortest segment worth attempting to decode (`https://t.co/1` is 20 chars). */
const MIN_DECODE_SEGMENT = 20;

/**
 * Options for the strict UTF-8 decoder used below.
 *
 * `fatal: true` is what makes a binary-but-valid-base64 payload (a thumbnail
 * hash, an opaque id) return `null` instead of decoding to U+FFFD and failing
 * later as "not a URL" — the honest answer is "this segment was never text".
 *
 * `@cloudflare/workers-types` declares the constructor's options without a
 * `fatal` member, while workerd implements the Encoding standard, which does
 * have one. The cast is therefore about the type declaration only and changes no
 * runtime behaviour. The target type is derived from the constructor itself
 * (`ConstructorParameters`, not `Parameters` — `TextDecoder` has no call
 * signature) rather than naming workers-types' option type, so this keeps
 * compiling if that declaration is ever renamed or gains `fatal`.
 */
type StrictDecoderOptions = ConstructorParameters<typeof TextDecoder>[1];
const fatalTextDecoderOptions = { fatal: true } as unknown as StrictDecoderOptions;

/**
 * TikTok's alternate short-link domain.
 *
 * SSSTik's own client-side `keyup` validator accepts it alongside `tiktok.com`
 * (its regex matches a host of `tiktok` *or* `xzcs3zlph` followed by `.com` and a
 * path). The literal pattern is deliberately not quoted here: it ends in the
 * two-character sequence that terminates a block comment, which silently
 * truncates the comment and breaks everything below it.
 */
export const TIKTOK_ALT_SHORT_HOST = 'xzcs3zlph.com';

export function isAllowedMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return ALLOWED_MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isTikTokOrAltHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'tiktok.com' ||
    host.endsWith('.tiktok.com') ||
    host === TIKTOK_ALT_SHORT_HOST ||
    host.endsWith(`.${TIKTOK_ALT_SHORT_HOST}`)
  );
}

/**
 * Decode a base64 path segment into a usable HTTPS URL, or `null` when the
 * segment is not base64, does not decode to UTF-8 text, or is not an HTTPS URL.
 *
 * Returns `null` rather than throwing on purpose: an SSSTik link may be a plain
 * proxy URL (`/dl/<opaque-id>`) that has to be *fetched* instead of decoded, and
 * the caller cannot know which without trying.
 */
export function decodeBase64UrlSegment(segment: string): string | null {
  const candidate = segment.trim();
  if (candidate.length < MIN_DECODE_SEGMENT || !BASE64_SEGMENT.test(candidate)) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(candidate);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  let text: string;
  try {
    text = new TextDecoder('utf-8', fatalTextDecoderOptions).decode(bytes);
  } catch {
    return null; // binary segment (a thumbnail hash, an id), not a URL
  }
  // Reject control characters and whitespace: a real URL has neither, and their
  // presence means we decoded something that was never base64 text.
  if (/[\u0000-\u0020\u007f]/.test(text)) return null;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  return parsed.href;
}

/**
 * Unwrap an SSSTik result link.
 *
 *   https://ssscdn.io/en/ssstik/<base64>  ->  the decoded target
 *   https://tikcdn.io/ssstik/a/<base64>   ->  the decoded target
 *   https://ssscdn.io/dl/abc123           ->  unchanged (fetch it, follow redirects)
 *
 * Two properties of the encoding make this less trivial than "decode the last
 * path segment":
 *
 *  - `/` is part of the base64 alphabet, so a long payload is *split across
 *    several path segments*. `ssscdn.io/en/ssstik/<248 chars>` parses as
 *    `["en","ssstik",<171>,<76>]`, and only rejoining the tail reconstructs it.
 *    Candidate spans therefore have to be rejoined, not read one segment at a
 *    time — a single-segment scan silently finds nothing for exactly the long,
 *    signed CDN URLs that matter most.
 *  - `=` padding is legal in a path, and `atob` also tolerates missing padding,
 *    so no mod-4 assumption is made.
 *
 * Every possible split is tried, so the intended reading is found whether the
 * wrapper prefixes the payload with one segment (`/ssstik/a/`), two
 * (`/<locale>/<product>/`) or none. Widest prefix first: that is the shape SSSTik
 * actually publishes, so the common case decodes on the first attempt.
 *
 * The *decoded* URL is returned unvalidated on purpose — the caller must run it
 * through the SSRF guard and the host allow-list exactly as it would any other
 * URL, because a decoded payload is attacker-influenced text that never appeared
 * in a response header.
 */
export function unwrapMediaUrl(href: string): { url: string; decoded: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    throw badRequest('SSSTik returned an invalid media URL.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!WRAPPER_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return { url: parsed.href, decoded: false };
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  // `parsed.pathname` excludes any query string, so a wrapper such as
  // `/dl/<id>?x=1` can never contribute it to a base64 candidate.
  // span = how many leading segments belong to the wrapper (`en/ssstik`, `ssstik/a`,
  // or none), so the payload is `segments.slice(span)`. Widest prefix first, because
  // that is the shape SSSTik publishes; every split is attempted before giving up.
  for (let span = Math.max(0, segments.length - 1); span >= 0; span -= 1) {
    const candidate = segments.slice(span).map((segment) => decodeURIComponent(segment)).join('/');
    const decoded = decodeBase64UrlSegment(candidate);
    if (decoded) return { url: decoded, decoded: true };
  }
  return { url: parsed.href, decoded: false };
}

// ---------------------------------------------------------------------------
// backend signals
// ---------------------------------------------------------------------------

/**
 * Every `HX-Trigger` event the SSSTik bundle listens for. Enumerated from its own
 * client (`script_ssstik.min.js`), so a signal we do not know is genuinely new
 * rather than a typo on our side.
 */
export type SsstikSignal =
  | 'ssssuccess'
  | 'ssssuccess_video'
  | 'ssssuccess_videoandmp3'
  | 'ssssuccess_slides'
  | 'ssssuccess_music'
  | 'ssssuccess_wmonly'
  | 'ssssuccess_scraptik'
  | 'sssinvalidlink'
  | 'ssstterror'
  | 'ssscurlerror'
  | 'sssblockedclient'
  | 'ssstokenfail'
  | 'sssfailure'
  | 'ssslimitexceed'
  | 'sssrapidapisuccess'
  | 'sssrapidapifail'
  | 'sssrapidapifakehd'
  | 'sssrapidapittfail';

/** Every signal we know, exported so tests can iterate it rather than restate it. */
export const ALL_SIGNALS: readonly SsstikSignal[] = [
  'ssssuccess',
  'ssssuccess_video',
  'ssssuccess_videoandmp3',
  'ssssuccess_slides',
  'ssssuccess_music',
  'ssssuccess_wmonly',
  'ssssuccess_scraptik',
  'sssinvalidlink',
  'ssstterror',
  'ssscurlerror',
  'sssblockedclient',
  'ssstokenfail',
  'sssfailure',
  'ssslimitexceed',
  'sssrapidapisuccess',
  'sssrapidapifail',
  'sssrapidapifakehd',
  'sssrapidapittfail',
];

/**
 * Signals that mean "stop and tell the operator": the post is fine, but SSSTik
 * cannot hand us a watermark-free MP4 for it.
 */
const HARD_FAILURE_SIGNALS: ReadonlySet<SsstikSignal> = new Set([
  'sssinvalidlink',
  'ssstterror',
  'ssscurlerror',
  'sssblockedclient',
  'sssfailure',
  'ssssuccess_wmonly',
  'ssssuccess_slides',
  'ssssuccess_music',
]);

const SIGNAL_MESSAGES: Readonly<Record<SsstikSignal, string>> = {
  ssssuccess: 'SSSTik reported success but returned no usable download link.',
  ssssuccess_video: 'SSSTik reported a video result but no MP4 link was present.',
  ssssuccess_videoandmp3: 'SSSTik reported a video result but no MP4 link was present.',
  ssssuccess_slides:
    'This post is a photo/slide carousel (SSSTik signal "slides"): it has no single MP4 to store.',
  ssssuccess_music:
    'SSSTik could only extract audio for this post (signal "music"): there is no MP4 to store.',
  ssssuccess_wmonly:
    'SSSTik could only find the watermarked version of this post (signal "wmonly"). VTGrab does not store watermarked copies through this provider.',
  ssssuccess_scraptik: 'SSSTik served this post through its fallback scraper path.',
  sssinvalidlink:
    'SSSTik did not recognise this link (signal "invalidlink"). It must be one public TikTok video or photo post.',
  ssstterror: 'SSSTik could not read this post from TikTok (signal "tterror"): it may be private, removed or region-blocked.',
  ssscurlerror: "SSSTik's own fetch of TikTok failed (signal \"curlerror\"). This is transient on their side.",
  sssblockedclient: 'SSSTik blocked this client or IP (signal "blockedclient"). Stop and check the deployment egress IP.',
  ssstokenfail: 'SSSTik rejected the page token (signal "tokenfail"); the shell page must be reloaded to obtain a fresh one.',
  sssfailure: 'SSSTik reported a generic failure for this post.',
  ssslimitexceed: 'SSSTik rate-limited this request (signal "limitexceed"); it asks for roughly 10 seconds between posts.',
  sssrapidapisuccess: 'SSSTik prepared an HD link through its paid upstream.',
  sssrapidapifail: "SSSTik's HD upstream failed for this post.",
  sssrapidapifakehd: "SSSTik reports this post has no true HD source, so its HD button is disabled.",
  sssrapidapittfail: "SSSTik's HD upstream rejected the page token.",
};

export class SsstikSignalError extends Error {
  public readonly signal: SsstikSignal;
  /**
   * How long the caller should wait before trying this post again. Only set for
   * genuinely transient signals, so a permanent one is not retried into the ground.
   */
  public readonly retryAfterSeconds?: number;

  constructor(signal: SsstikSignal, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'SsstikSignalError';
    this.signal = signal;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Read the backend signal out of an `HX-Trigger` response header.
 *
 * HTMX accepts two spellings — a bare event name, or JSON mapping names to
 * detail — and SSSTik uses the bare form plus `ssstokenfail` with a detail value.
 * Returns `null` for anything we do not recognise so an unrelated HTMX event can
 * never be mistaken for a verdict.
 */
export function parseSsstikSignal(headers: Headers): SsstikSignal | null {
  const raw = headers.get('hx-trigger') ?? headers.get('HX-Trigger');
  if (!raw) return null;
  const names: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      names.push(...Object.keys(parsed));
    } catch {
      return null;
    }
  } else {
    names.push(...trimmed.split(/[\s,;]+/).filter(Boolean));
  }
  for (const name of names) {
    if ((ALL_SIGNALS as readonly string[]).includes(name)) return name as SsstikSignal;
  }
  return null;
}

export function describeSignal(signal: SsstikSignal): string {
  return SIGNAL_MESSAGES[signal];
}

export function isHardFailureSignal(signal: SsstikSignal): boolean {
  return HARD_FAILURE_SIGNALS.has(signal);
}

/**
 * Signals about SSSTik's *HD* tier, which is a separate paid upstream we do not
 * use. They say nothing about whether a watermark-free MP4 exists, so they must
 * not be reported as the reason an episode failed.
 */
const HD_TIER_SIGNALS: ReadonlySet<SsstikSignal> = new Set([
  'sssrapidapisuccess',
  'sssrapidapifail',
  'sssrapidapifakehd',
  'sssrapidapittfail',
]);

export function isHdTierSignal(signal: SsstikSignal): boolean {
  return HD_TIER_SIGNALS.has(signal);
}

/** The cooldown SSSTik itself asks for when it emits `ssslimitexceed`. */
export const RATE_LIMIT_COOLDOWN_SECONDS = 12;

/**
 * Turn a signal into the error the operator should see (null when benign).
 *
 * `rateLimitSeconds` overrides the cooldown SSSTik asks for, so a deployment can
 * be tuned (and the retry path tested) without changing the verdict itself.
 */
export function signalError(
  signal: SsstikSignal,
  rateLimitSeconds: number = RATE_LIMIT_COOLDOWN_SECONDS,
): SsstikSignalError | null {
  if (signal === 'ssslimitexceed') {
    return new SsstikSignalError(signal, describeSignal(signal), Math.max(0, rateLimitSeconds));
  }
  if (signal === 'ssstokenfail' || signal === 'ssscurlerror' || signal === 'ssstterror') {
    // Transient: a fresh shell token (or their upstream recovering) can fix these.
    return new SsstikSignalError(signal, describeSignal(signal), undefined);
  }
  if (isHardFailureSignal(signal)) return new SsstikSignalError(signal, describeSignal(signal));
  return null;
}
