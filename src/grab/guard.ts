import { badRequest } from '../core/errors';
import type { GrabConfig } from './config';

/**
 * Request-target policy for the grabber.
 *
 * The Worker turns a user supplied URL into a server side request, so the URL has to
 * be screened before it leaves the isolate:
 *
 *   - only http(s), no credentials, no `data:`/`file:`/`javascript:`
 *   - loopback, RFC1918, link-local (this is where cloud metadata lives),
 *     carrier-grade NAT, multicast and reserved ranges are refused
 *   - reserved pseudo TLDs (`.localhost`, `.local`, `.internal`, `.test`, ...) refused
 *   - an optional operator allow-list / deny-list on top
 *
 * Workers cannot resolve DNS names from JavaScript, so a *hostname* that resolves to
 * a private address cannot be screened here. That is acceptable on Cloudflare (a
 * Worker has no route to a customer VPC or the link-local metadata IP) but is the
 * reason `GRAB_ALLOWED_HOSTS` exists: production deployments that run the grabber
 * open to the whole internet should restrict it to the hosts they actually serve.
 */

export const RESERVED_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.test',
  '.invalid',
  '.example',
  '.bit',
  '.onion',
  '.i2d',
];

/** Hostnames that must never be fetched from a server side component. */
export const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'cloudflare-worker-local',
  'hostname',
  'local',
]);

export type AddressFamily = 'ipv4' | 'ipv6' | 'name';

export function addressFamily(host: string): AddressFamily {
  if (host.startsWith('[') && host.endsWith(']')) return 'ipv6';
  if (host.includes(':')) return 'ipv6';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'ipv4';
  return 'name';
}

export function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '').replace(/%.*$/i, '').toLowerCase();
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Expand an IPv6 literal into 16 bytes (supports `::` compression and v4 suffix). */
export function parseIpv6(input: string): Uint8Array | null {
  let value = input.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(value)) return null;

  // Trailing IPv4 form (::ffff:1.2.3.4) -> replace with two hextets.
  const v4Match = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (v4Match) {
    const octets = parseIpv4(v4Match[1]);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = value.slice(0, value.length - v4Match[1].length) + `${high}:${low}`;
  }

  const doubleColon = value.indexOf('::');
  if (doubleColon >= 0 && value.indexOf('::', doubleColon + 1) >= 0) return null;

  const head = doubleColon >= 0 ? value.slice(0, doubleColon) : value;
  const tail = doubleColon >= 0 ? value.slice(doubleColon + 2) : '';
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');
  if (headParts.some((part) => part.length > 4) || tailParts.some((part) => part.length > 4)) {
    return null;
  }
  if (doubleColon < 0 && headParts.length !== 8) return null;
  const total = headParts.length + tailParts.length;
  if (doubleColon >= 0 && total > 7) return null;
  const missing = 8 - total;
  const parts = doubleColon >= 0 ? [...headParts, ...new Array(missing).fill('0'), ...tailParts] : headParts;
  if (parts.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (const [index, part] of parts.entries()) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    const word = Number.parseInt(part, 16);
    bytes[index * 2] = (word >>> 8) & 0xff;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function startsWith(bytes: Uint8Array, leading: number[], maskBytes: number): boolean {
  for (let index = 0; index < maskBytes; index += 1) {
    if (index < leading.length && bytes[index] !== leading[index]) return false;
    if (index >= leading.length && bytes[index] !== 0) return false;
  }
  return true;
}

/** True for every address a server-side fetcher must not touch. */
export function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (169.254.169.254 = cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments / NAT64 well-known
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

export function isPrivateIpv6(bytes: Uint8Array): boolean {
  if (bytes.every((byte) => byte === 0)) return true; // :: unspecified
  if (bytes[0] === 0 && bytes[15] === 1 && bytes.subarray(1, 15).every((b) => b === 0)) return true; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xff) return true; // multicast
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true; // NAT64
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    // 6to4 embeds an IPv4 in bytes 2..5.
    return isPrivateIpv4([bytes[2], bytes[3], bytes[4], bytes[5]]);
  }
  if (startsWith(bytes, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff], 12)) {
    return isPrivateIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]); // v4 mapped
  }
  return false;
}

export interface HostCheck {
  ok: boolean;
  reason?: string;
  host: string;
}

export function checkHostname(rawHost: string, cfg: GrabConfig): HostCheck {
  const host = stripBrackets(rawHost);
  if (host.length === 0) return { ok: false, reason: 'empty hostname', host };

  const family = addressFamily(rawHost.toLowerCase());
  const privateAllowed = cfg.allowPrivateHosts;

  if (family === 'ipv4') {
    const octets = parseIpv4(host);
    if (!octets) return { ok: false, reason: 'malformed IPv4 literal', host };
    if (isPrivateIpv4(octets) && !privateAllowed) {
      return { ok: false, reason: 'IPv4 literal points at a private/reserved network', host };
    }
  } else if (family === 'ipv6') {
    const bytes = parseIpv6(host);
    if (!bytes) return { ok: false, reason: 'malformed IPv6 literal', host };
    if (isPrivateIpv6(bytes) && !privateAllowed) {
      return { ok: false, reason: 'IPv6 literal points at a private/reserved network', host };
    }
  } else {
    if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: 'blocked internal hostname', host };
    if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      // Reserved pseudo TLDs are unreachable from a Worker anyway; refusing them here
      // also keeps the mock-only hosts (e.g. `mock.local`) out of the network path.
      return { ok: false, reason: `reserved name "${host}"`, host };
    }
    if (!host.includes('.')) return { ok: false, reason: 'single label hostname (internal resolver)', host };
  }

  const matched = (list: string[]) =>
    list.some((entry) => host === entry || host.endsWith(`.${entry}`));

  if (matched(cfg.denylist)) return { ok: false, reason: 'host is in GRAB_DENIED_HOSTS', host };
  if (cfg.allowlist.length > 0 && !matched(cfg.allowlist)) {
    return { ok: false, reason: 'host is not in GRAB_ALLOWED_HOSTS', host };
  }
  return { ok: true, host };
}

export interface SafeUrl {
  url: URL;
  host: string;
}

/** Validate a URL as a fetch target, throwing a 400 with a readable reason. */
export function safeUrl(input: string | URL, cfg: GrabConfig): SafeUrl {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
  } catch {
    throw badRequest(`Not a usable URL: ${String(input).slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`Only http and https targets are supported (got "${url.protocol}")`);
  }
  if (url.username || url.password) {
    throw badRequest('Credentials in the URL are not supported; the grabber sends no cookies or auth');
  }
  if (url.protocol === 'https:' && url.port === '80') url.port = '';

  const check = checkHostname(url.hostname, cfg);
  if (!check.ok) throw badRequest(`Refusing to fetch ${url.hostname}: ${check.reason}`, { url: url.toString() });
  return { url, host: check.host };
}

/** Non throwing variant used while sniffing, where a bad link is just skipped. */
export function trySafeUrl(input: string, cfg: GrabConfig, baseUrl: URL): URL | null {
  try {
    const absolute = new URL(input, baseUrl);
    return safeUrl(absolute, cfg).url;
  } catch {
    return null;
  }
}
