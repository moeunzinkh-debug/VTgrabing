#!/usr/bin/env node
/**
 * Local "site under test" for the real link grabber.
 *
 * This is a development tool (it is not part of the Worker). It serves a small site
 * that publishes its videos in every way the grabber claims to understand, so the
 * whole flow can be exercised end to end without touching a third party website:
 *
 *   /                      page with <video> + <source> renditions, an og:video
 *                          manifest, a player config blob and JSON-LD
 *   /ep/1..3               episode pages (exercises the index crawler)
 *   /player.html           <iframe> player document (exercises embed following)
 *   /media/bunny.mp4       the real MP4, served with Accept-Ranges + Range support
 *   /media/hls/*           HLS master -> variant -> byte-sliced .ts segments
 *   /media/cmaf/*          fMP4/CMAF variant with #EXT-X-MAP (init + .m4s)
 *   /media/dash/*          DASH MPD with SegmentTemplate + SegmentTimeline
 *   /media/live/*          playlist without #EXT-X-ENDLIST  -> must be refused
 *   /media/encrypted/*     #EXT-X-KEY:METHOD=AES-128       -> must be refused
 *
 * Segment payloads are slices of the source file, which is exactly what the
 * downloader has to reproduce (byte-exact concatenation, in order). They are not
 * remuxed MPEG-TS - that would need ffmpeg, which the Worker does not have either.
 *
 * Usage:
 *   node scripts/fixture-site.mjs                          # http://127.0.0.1:8099
 *   MEDIA=/path/to/real.mp4 node scripts/fixture-site.mjs  # use your own media
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.PORT ?? '8099', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const ROOT = process.env.FIXTURE_DIR ?? '/tmp/vtgrab-fixture';
const PROVIDED = process.env.MEDIA ?? join(ROOT, 'bunny.mp4');
const ORIGIN = `http://${HOST}:${PORT}`;

const SEGMENT_COUNT = 4;

const log = (...args) => console.log('[fixture]', ...args);

/** Deterministic bytes, used when no real media file was supplied. */
function syntheticPayload(length, seed) {
  const buffer = Buffer.alloc(length);
  let state = (seed >>> 0) || 0x9e3779b9;
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buffer.writeUInt32BE(state, offset);
  }
  buffer.write('VTGRAB-FIXTURE-VIDEO ', 0, 'ascii');
  return buffer;
}

function write(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, data);
}

/** Build the fixture tree on disk and return the sizes the pages advertise. */
export function buildFixture() {
  mkdirSync(ROOT, { recursive: true });
  const bytes = existsSync(PROVIDED) && statSync(PROVIDED).isFile()
    ? Buffer.from(readFileSync(PROVIDED))
    : (() => {
        log(`no media at ${PROVIDED}, generating deterministic synthetic bytes`);
        const generated = syntheticPayload(3 * 1024 * 1024 + 7, 12345);
        write(join(ROOT, 'bunny.mp4'), generated);
        return generated;
      })();

  const segmentSize = Math.ceil(bytes.length / SEGMENT_COUNT);
  const durations = [];
  for (let index = 0; index < SEGMENT_COUNT; index += 1) {
    const start = index * segmentSize;
    const slice = bytes.subarray(start, Math.min(bytes.length, start + segmentSize));
    write(join(ROOT, 'media', 'hls', `seg-${index + 1}.ts`), slice);
    durations.push({ name: `seg-${index + 1}.ts`, length: slice.length });
  }
  write(
    join(ROOT, 'media', 'hls', 'media.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:1',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      ...durations.flatMap((entry) => [`#EXTINF:6.000,`, entry.name]),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  );
  write(
    join(ROOT, 'media', 'hls', 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5200000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
      'media.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      'media.m3u8',
      '',
    ].join('\n'),
  );

  // fMP4 / CMAF flavour: one init segment plus m4s parts.
  const init = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftypisom', 'binary'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('isomiso2avc1mp41', 'binary'),
  ]);
  write(join(ROOT, 'media', 'cmaf', 'init.mp4'), init);
  const cmafParts = [];
  const partSize = Math.ceil(bytes.length / 3);
  for (let index = 0; index < 3; index += 1) {
    const start = index * partSize;
    const slice = bytes.subarray(start, Math.min(bytes.length, start + partSize));
    write(join(ROOT, 'media', 'cmaf', `part-${index + 1}.m4s`), slice);
    cmafParts.push({ name: `part-${index + 1}.m4s`, length: slice.length });
  }
  write(
    join(ROOT, 'media', 'cmaf', 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:8',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="init.mp4"',
      ...cmafParts.flatMap((entry) => ['#EXTINF:8.000,', entry.name]),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  );

  write(
    join(ROOT, 'media', 'dash', 'manifest.mpd'),
    `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT24S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.640028" segmentAlignment="true">
      <SegmentTemplate initialization="../cmaf/init.mp4" media="../cmaf/part-$Number$.m4s" startNumber="1" timescale="12000">
        <SegmentTimeline>${cmafParts.map(() => '<S d="96000"/>').join('')}</SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1080" bandwidth="4800000" width="1920" height="1080"/>
      <Representation id="720" bandwidth="2400000" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>
`,
  );

  // Refusal cases.
  write(
    join(ROOT, 'media', 'encrypted', 'master.m3u8'),
    ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=4800000,RESOLUTION=1920x1080', 'media.m3u8', ''].join('\n'),
  );
  write(
    join(ROOT, 'media', 'encrypted', 'media.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:6.000,',
      'seg-1.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  );
  write(join(ROOT, 'media', 'encrypted', 'key.bin'), Buffer.alloc(16, 7));
  write(join(ROOT, 'media', 'encrypted', 'seg-1.ts'), bytes.subarray(0, 1024));
  write(
    join(ROOT, 'media', 'live', 'media.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:1',
      '#EXTINF:6.000,',
      'seg-1.ts',
      '',
    ].join('\n'),
  );
  write(join(ROOT, 'media', 'live', 'seg-1.ts'), bytes.subarray(0, 1024));

  // "Extra files" the pages link to: each is a deterministic payload of its own.
  const named = {};
  for (const name of ['clip-1080p.mp4', 'clip-720p.mp4', 'clip-480p.mp4', 'embedded.mp4', 'episode-1.mp4', 'episode-2.mp4', 'episode-3.mp4', 'episode-1-preview.mp4', 'episode-2-preview.mp4', 'episode-3-preview.mp4']) {
    const length = 512 * 1024 + (name.length * 7919) % (1024 * 1024);
    const buffer = syntheticPayload(length, name.split('').reduce((total, char) => total + char.charCodeAt(0), 0));
    named[name] = buffer;
  }

  return { bytes, named, segments: durations, cmafParts, init };
}

function page(name) {
  return name.replace(/\.mp4$/, '').replace(/-/g, ' ');
}

function renderIndex() {
  const items = [
    ['/media/clip-720p.mp4', 'Rabbit chase (720p)'],
    ['/media/clip-480p.mp4', 'Rabbit chase (480p)'],
    ['/media/cmaf/master.m3u8', 'CMAF / fragmented MP4 variant'],
    ['/media/dash/manifest.mpd', 'DASH representation'],
    ['/media/encrypted/master.m3u8', 'Backstage (protected)'],
    ['/media/live/media.m3u8', 'Premiere (live)'],
    ['/ep/1', 'Episode 1'],
    ['/ep/2', 'Episode 2'],
    ['/ep/3', 'Episode 3'],
  ]
    .map(([href, label]) => `      <li><a href="${href}">${label}</a></li>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Big Buck Bunny - grabber fixture</title>
    <meta property="og:title" content="Big Buck Bunny - grabber fixture" />
    <meta property="og:description" content="A local fixture site that publishes its videos in six different ways." />
    <meta property="og:image" content="${ORIGIN}/poster.jpg" />
    <meta property="og:video" content="${ORIGIN}/media/hls/master.m3u8" />
    <meta property="og:video:type" content="application/vnd.apple.mpegurl" />
  </head>
  <body>
    <h1>Grabber fixture</h1>

    <video poster="${ORIGIN}/poster.jpg" data-title="Feature presentation" controls>
      <source src="${ORIGIN}/media/bunny.mp4" type="video/mp4" label="1080p" />
      <source src="/media/hls/master.m3u8" type="application/vnd.apple.mpegurl" label="adaptive" />
    </video>

    <h2>More</h2>
    <ul>
${items}
    </ul>

    <iframe src="/player.html" width="640" height="360" title="embedded player"></iframe>

    <script>
      // A player-config blob: the other way sites publish their renditions.
      var playerConfig = {
        title: 'Rabbit chase',
        sources: [
          { file: '\\/media\\/clip-1080p.mp4', label: '1080p', 'default': true },
          { file: '${ORIGIN}/media/clip-720p.mp4', label: '720p' },
          { file: '/media/hls/master.m3u8', type: 'hls', label: 'auto' }
        ]
      };
    </script>

    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Movie",
        "name": "Big Buck Bunny",
        "image": "${ORIGIN}/poster.jpg",
        "video": [
          { "@type": "VideoObject", "name": "Feature presentation", "contentUrl": "${ORIGIN}/media/bunny.mp4" }
        ]
      }
    </script>
  </body>
</html>
`;
}

const PLAYER_PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Embedded player</title></head>
  <body><video controls src="/media/embedded.mp4?token=player"></video></body>
</html>
`;

const episodePage = (index) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Fixture episode ${index}</title>
    <meta property="og:video" content="${ORIGIN}/media/episode-${index}.mp4" />
  </head>
  <body>
    <h1>Episode ${index}</h1>
    <video controls src="${ORIGIN}/media/episode-${index}.mp4"></video>
    <a href="/media/episode-${index}-preview.mp4">${page(`episode-${index}-preview.mp4`)}</a>
  </body>
</html>
`;

export function createFixtureServer(fixture) {
  const typeFor = (path) =>
    path.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : path.endsWith('.mpd')
        ? 'application/dash+xml'
        : path.endsWith('.ts')
          ? 'video/mp2t'
          : path.endsWith('.m4s')
            ? 'video/iso.segment'
            : path.endsWith('.mp4')
              ? 'video/mp4'
              : 'application/octet-stream';

  const send = (response, request, buffer, type, { ranges = true } = {}) => {
    const headers = {
      'content-type': type,
      'content-length': String(buffer.length),
      'x-fixture': 'vtgrab',
      ...(ranges ? { 'accept-ranges': 'bytes' } : {}),
    };
    const match = ranges ? /bytes=(\d*)-(\d*)/.exec(request.headers.range ?? '') : null;
    if (match && request.method === 'GET') {
      const start = match[1] === '' ? Math.max(0, buffer.length - Number.parseInt(match[2], 10)) : Number.parseInt(match[1], 10);
      const end = match[1] === '' || match[2] === '' ? buffer.length - 1 : Math.min(buffer.length - 1, Number.parseInt(match[2], 10));
      const slice = buffer.subarray(start, end + 1);
      response.writeHead(206, {
        ...headers,
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${end}/${buffer.length}`,
      });
      return response.end(slice);
    }
    response.writeHead(200, headers);
    return response.end(request.method === 'HEAD' ? undefined : buffer);
  };

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', ORIGIN);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') return send(response, request, Buffer.from(renderIndex()), 'text/html; charset=utf-8', { ranges: false });
    if (path === '/player.html') return send(response, request, Buffer.from(PLAYER_PAGE), 'text/html; charset=utf-8', { ranges: false });
    const episode = /^\/ep\/(\d+)$/.exec(path);
    if (episode) return send(response, request, Buffer.from(episodePage(Number.parseInt(episode[1], 10))), 'text/html; charset=utf-8', { ranges: false });
    if (path === '/needs-referer.mp4') {
      if (!(request.headers.referer ?? '').includes(HOST)) {
        response.writeHead(403, { 'content-type': 'text/plain' });
        return response.end('hotlink protection: referer required');
      }
      return send(response, request, fixture.named['clip-480p.mp4'] ?? fixture.bytes, 'video/mp4');
    }

    const named = /^\/media\/([a-z0-9-]+\.mp4)$/.exec(path);
    if (named && fixture.named[named[1]]) return send(response, request, fixture.named[named[1]], 'video/mp4');
    if (path === '/media/bunny.mp4') return send(response, request, fixture.bytes, 'video/mp4');

    if (path.startsWith('/media/')) {
      const file = join(ROOT, path);
      if (file.startsWith(ROOT) && existsSync(file) && statSync(file).isFile()) {
        return send(response, request, Buffer.from(readFileSync(file)), typeFor(path));
      }
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
}

export async function start() {
  const fixture = buildFixture();
  const server = createFixtureServer(fixture);
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  log(`listening on ${ORIGIN}`);
  log(`  ${ORIGIN}/                  page with <video> + manifest + player config + JSON-LD`);
  log(`  ${ORIGIN}/ep/1             episode page (index crawling)`);
  log(`  ${ORIGIN}/media/bunny.mp4  ${fixture.bytes.length} bytes, Range supported`);
  return { server, origin: ORIGIN, fixture };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await start();
}
