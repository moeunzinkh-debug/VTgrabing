function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Short, collision resistant, URL safe identifier: `<prefix>_<24 hex chars>`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

/** Deterministic 32-bit FNV-1a hash, used by the mock providers. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hexFromHash(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Filesystem/object-store safe slug. */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}

export function padNumber(value: number, size = 2): string {
  return String(Math.max(0, Math.trunc(value))).padStart(size, '0');
}

/** Deterministic season/episode style label: `S01E03`. */
export function episodeLabel(index: number): string {
  return `S01E${padNumber(index, 2)}`;
}
