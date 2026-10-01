# VTGrab

Series/episode analyzer and download-job orchestrator that runs entirely on
**Cloudflare Workers** with **D1** (metadata), **R2** (objects) and **Queues**
(orchestration). The frontend is a Vite-bundled single page app served as static
assets by the same Worker.

> **What this project is not.** VTGrab contains **no scraper, no DRM
> circumvention and no bundled downloader**. In production it analyzes and
> downloads only through services the operator is **authorized** to call (their
> own catalog API and their own/partner download service). The `MockExtractor`
> and `MockDownloadProvider` exist **only** for `wrangler dev` and the automated
> tests; they generate clearly labelled synthetic bytes and are disabled by
> default (`MOCK_ENABLED=false`).

---

## Table of contents

1. [Architecture](#architecture)
2. [Data model](#data-model)
3. [Quick start (local)](#quick-start-local)
4. [Real link grabbing](#real-link-grabbing) · [TikTok link analysis](#tiktok-link-analysis)
5. [Deployment to Cloudflare (exact commands)](#deployment-to-cloudflare-exact-commands)
6. [Environment variables & secrets](#environment-variables--secrets)
7. [HTTP API](#http-api)
8. [Authorized source integration (extractor contract)](#authorized-source-integration-extractor-contract)
9. [Authorized download service (provider contract)](#authorized-download-service-provider-contract)
10. [Runtime limitations of Workers and how this design handles them](#runtime-limitations-of-workers-and-how-this-design-handles-them)
11. [Testing](#testing)
12. [Project layout](#project-layout)
13. [Khmer summary](#khmer-summary-សង្ខបជាភាសាខ្មរ)

---

## Architecture

```
                    ┌───────────────────────────────────────────────┐
  browser ─────────▶│ Cloudflare Worker (src/index.ts, Hono router) │
   (Vite SPA)       │                                               │
                    │  POST /api/analyze  ──▶ SourceExtractor       │──▶ authorized catalog API
                    │  POST /api/jobs     ──▶ JobService            │    (SOURCE_API_BASE_URL)
                    │  GET  /api/jobs/:id ──▶ Repository (D1)       │
                    │  GET  /api/files/:id/content ──▶ R2           │
                    └───────────────┬───────────────────────────────┘
                                    │ sendBatch()
                                    ▼
                          ┌──────────────────┐
                          │ Queue  vtgrab-jobs│
                          └────────┬─────────┘
                                   │ queue() consumer
                                   ▼
                    ┌───────────────────────────────────────────────┐
                    │ Orchestrator (src/jobs/orchestrator.ts)       │
                    │  job.init / job.item / job.finalize           │
                    │  concurrency limiter + retry with backoff     │
                    └───────┬───────────────────────┬───────────────┘
                            │ inline stream         │ deferred
                            ▼                       ▼
                   ┌─────────────────┐   ┌──────────────────────────────┐
                   │ R2 (multipart)  │   │ authorized download service  │
                   │ + files row     │◀──│ PUT callback (HMAC signed)   │
                   └─────────────────┘   │ or poll GET /v1/downloads/:id│
                                         └──────────────────────────────┘
   cron */5 ───▶ runMaintenance(): polls stale deferred jobs, fails timeouts
```

State machine — job: `pending → running → completed | partial | failed | cancelled`.
State machine — job item: `pending → downloading → completed | failed | cancelled`.

`jobs` counters are **never** incremented by hand: `Repository.recomputeJob()`
recomputes them from `job_items` and derives the job status, so progress can not
drift (Queues is at-least-once, every handler is idempotent).

---

## Data model

D1 tables (see `migrations/0001_init.sql`, `migrations/0002_job_events.sql`):

| table       | purpose                                                              |
| ----------- | -------------------------------------------------------------------- |
| `series`    | one row per analyzed catalog entry (dedup by `canonical_url`)         |
| `episodes`  | episodes of a series, 1-based `episode_index`, `streams` as JSON      |
| `jobs`      | one download job: selection, options, counters, timestamps            |
| `job_items` | one row per episode inside a job: status, progress, attempts, R2 key  |
| `files`     | one row per stored object: bucket, key, size, etag, sha256, provider  |
| `job_events`| append-only audit log rendered by the frontend "Activity" panel       |

---

## Quick start (local)

```bash
git clone <your-fork> vtgrab && cd vtgrab
npm install

# 1. create the local database from the migrations and build the frontend
npm run dev            # `predev` runs `vite build` + `wrangler d1 migrations apply --local`

# open http://localhost:8787
```

`npm run dev` starts `wrangler dev` bound to `0.0.0.0:8787` with **local** D1, R2
and Queues. Copy `.dev.vars.example` to `.dev.vars` (git-ignored) — it enables the
mock extractor/provider:

```bash
cp .dev.vars.example .dev.vars
```

Then, in the UI: paste `https://mock.local/series/anything` → **Analyze** →
select episodes (checkbox, shift-click range, `from–to` range, Select all /
Deselect all / Invert) → **Download selected** / **Download all** → watch the job
progress from the backend (auto refresh every 2 s) → download the stored object
from **Files in R2**.

Useful extras:

```bash
npm run dev:client     # Vite dev server on :5173 with /api proxied to :8787 (HMR)
npm run db:migrate:local
npm run typecheck
npm test
npm run build
```

---

## Real link grabbing

This is the default path: paste a link, press **Analyze**, and VTGrab opens that link,
finds every video it can see there, and queues all of them. Nothing in this flow is
sample data - each number in the listing came from a response by the media host, and
every stored byte was transferred from that host.

```
link ──▶ POST /api/analyze { url, queueAll: true }
          │
          ├─ open the page (real GET, text-limited, timeout-bounded)
          ├─ find video URLs            <video>/<source>, <a href>, <link rel=preload>,
          │                              og:video / twitter:player, data-* attributes,
          │                              jwplayer/videojs config blobs, JSON-LD VideoObject,
          │                              a raw scan of the document as a last resort
          ├─ follow embedded players     <iframe>/<embed> players, up to 6 hops deep
          ├─ crawl the episode list      same-origin links that look like episodes, so one
          │                              series URL turns into every video it announces
          ├─ confirm each candidate      HEAD (or a 1-byte Range GET) against the media
          │                              host: a URL that does not answer with media is
          │                              dropped, never queued
          └─ read the manifests          HLS master → rendition → segment list;
                                         DASH SegmentTemplate/SegmentList/SegmentBase;
                                         real duration, segment count, bitrate, size
                                         estimate, container and the encryption verdict
      ──▶ one job item per grabbable video (selection: all), persisted in D1
      ──▶ http-stream downloads the bytes into R2
```

### What "real download" means here

| source shape          | how the bytes arrive                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| one progressive file  | `Range` chunks of `GRAB_CHUNK_BYTES` (5-64 MiB), assembled as an R2 multipart upload; a chunk that comes back short is re-requested, and a body that ends early fails instead of storing a truncated file |
| HLS (`.m3u8`)         | segments fetched in parallel but concatenated in playlist order; MPEG-TS stays `.ts`, `#EXT-X-MAP` (fMP4/CMAF) gets the init segment in front |
| DASH (`.mpd`)         | `SegmentTemplate` (with `$Number$`/`$Time$`/`$RepresentationID$` and `SegmentTimeline`), `SegmentList` or a single-file `SegmentBase` |

Progress is written per item (`part n/m`, `segment n/m`) and the container of the stored
object follows what the manifest actually contains, so the file name matches the bytes.

### What it will not do

* **No DRM, no key fetching.** A `#EXT-X-KEY` or `ContentProtection` stream is listed with
  `encrypted - not grabbable`, its checkbox is disabled, and `JobService` refuses to create
  an item for it. (Live playlists without `#EXT-X-ENDLIST` are treated the same way: there
  is no finished file yet.)
* **No cookies, tokens or header injection.** The only request headers are a browser-like
  `User-Agent`, `Accept`/`Range`, and a `Referer`/`Origin` echoing the page the link came
  from - which is what hotlink-protected hosts require. A login-only video stays
  login-only, and the error says so instead of pretending.
* **Only public, non-private addresses.** Private, link-local (cloud metadata), CGNAT,
  multicast and reserved names (`.localhost`, `.local`, `.internal`, `.test`, …) are refused
  before the request leaves the isolate; `GRAB_ALLOWED_HOSTS` / `GRAB_DENIED_HOSTS` narrow it
  further. Loopback targets are only possible outside production with
  `GRAB_ALLOW_PRIVATE_HOSTS=true`.
* **Budgeted.** `GRAB_MAX_VIDEOS`, `GRAB_MAX_CANDIDATES`, `GRAB_MAX_CRAWL_PAGES`,
  `GRAB_MAX_VIDEO_BYTES` and `GRAB_MAX_SUBREQUESTS` cap one analyze/download; the analyze
  request itself is aborted past `min(50s, 3 × GRAB_PAGE_TIMEOUT_MS)`.

### Grabber variables

| name | default | meaning |
| ---- | ------- | ------- |
| `GRAB_ENABLED` | `true` | turns the real grabber on; with it off, `mock`/authorized providers only |
| `GRAB_ALLOWED_HOSTS` | `""` | comma separated hosts that may be opened (empty = any public host) |
| `GRAB_DENIED_HOSTS` | `""` | hosts that may never be opened |
| `GRAB_ALLOW_PRIVATE_HOSTS` | `false` | development only: allow loopback/RFC1918 targets (ignored when `ENVIRONMENT=production`) |
| `GRAB_MAX_VIDEOS` | `200` | most videos one link may produce |
| `GRAB_MAX_CANDIDATES` | `120` | most URLs sniffed per document |
| `GRAB_CRAWL` / `GRAB_MAX_CRAWL_PAGES` | `true` / `24` | follow episode links found on the page |
| `GRAB_FOLLOW_EMBEDS` | `true` | open `<iframe>`/`<embed>` players |
| `GRAB_PAGE_TIMEOUT_MS` / `GRAB_MEDIA_TIMEOUT_MS` | `20000` / `180000` | per-request timeouts |
| `GRAB_MAX_PAGE_BYTES` | `4194304` | how much of a document is read |
| `GRAB_MAX_VIDEO_BYTES` | `3221225472` | per-object size cap (3 GiB) |
| `GRAB_CHUNK_BYTES` | `8388608` | progressive Range part size, and the R2 part size up to the writer's 8 MiB buffering cap |
| `GRAB_PROBE` | `true` | confirm every candidate against the media host before listing it |
| `GRAB_FETCH_CONCURRENCY` | `8` | parallel segment fetches |
| `GRAB_MAX_SUBREQUESTS` | `900` | fetch budget per invocation |
| `GRAB_USER_AGENT` | a Chrome UA | what the origin sees |

`GET /api/preview?url=…` is the one media proxy the UI uses: it re-applies the same host
policy, refuses manifests and non-media content types, passes through a `Range` header, and
never forwards cookies - so in-browser playback of a remote file works without exposing the
grabber as an open proxy.

In the UI, **Analyze** means “found video sources,” not “download finished.” A queued job is
shown separately under Jobs; completed media appears in **Downloaded files (R2)**, where
browser-compatible files can be played inline. Direct progressive sources also have a
“Watch here” preview through `/api/preview`. Adaptive HLS/DASH sources need to be downloaded
first. The `mock` provider is visibly marked as synthetic test data and is not presented as a
playable video.

### Proving it works, locally, with real bytes

```bash
npm run verify:grab        # fixture site + wrangler dev + analyze + download + SHA-256
```

`scripts/verify-grab-e2e.mjs` starts `scripts/fixture-site.mjs` (a page that publishes the
same video as a `<video>` tag, an anchor, a manifest, a player config blob and JSON-LD, plus
an episode index, an embedded player, an encrypted playlist and a live playlist), runs the
Worker with `MOCK_ENABLED:false`, then checks: the grabber was used, every video was found,
the protected and live ones were refused rather than queued, and **the bytes stored in R2 are
byte-identical (SHA-256) to the bytes the fixture served** - for the progressive file
(larger than one `GRAB_CHUNK_BYTES` part, so it is fetched with several `Range` requests and
stored as several R2 parts - the recorded part count is checked, not assumed), for the HLS
concatenation, and for the CMAF/DASH init-segment cases. The fixture payload size is set by the
verifier through `FIXTURE_BYTES`; running `node scripts/fixture-site.mjs` on its own keeps the
default 3 MiB.

To drive it by hand instead:

```bash
MEDIA=/path/to/any.mp4 node scripts/fixture-site.mjs &      # the site under test
npx wrangler dev --ip 127.0.0.1 --port 8787 \
  --var ENVIRONMENT:development --var MOCK_ENABLED:false \
  --var GRAB_ALLOW_PRIVATE_HOSTS:true                        # the Worker
# open http://127.0.0.1:8787 and analyze http://127.0.0.1:8099/
```

Against a real internet host, deploy the Worker (`npm run deploy`) and analyze any page
whose videos are publicly reachable - a deployed Worker has normal outbound access, which
a sandboxed dev server usually does not.

---

## TikTok link analysis

Paste a TikTok link and the tool shows what it is and lists its episodes:

```
Paste TikTok URL
  -> resolve short URL                 vm.tiktok.com / vt.tiktok.com / tiktok.com/t/...
  -> public page, or public oEmbed     (or your authorized catalog API, see below)
  -> mini-drama or normal video?
  -> title, episode number, episode list
  -> shown in the tool (section "2. Videos found on that link")
```

Implemented by `src/providers/extract/tiktok.ts` (network) and `src/grab/tiktok.ts`
(pure parsing/classification, unit-tested in `test/tiktok.test.ts`). It is registered
as extractor `tiktok`, ahead of the generic `http-sniff`.

* **Resolve.** A short link is followed hop by hop; every hop must stay on `tiktok.com`
  and pass the normal host policy, so a short link can never steer the Worker elsewhere.
  Tracking parameters (`_r`, `u_code`, `share_*`, ...) are dropped. TikTok's edge often
  bot-checks server-side redirect fetches (403, no `Location`); when that happens the
  hop is recorded in the diagnostics, and if the hop answers 200 with an interstitial
  the long URL is sniffed out of the page (`og:url`, `rel=canonical`, embed attributes,
  first absolute video URL).
* **Read.** The public HTML's embedded page data (`__UNIVERSAL_DATA_FOR_REHYDRATION__`),
  then Open Graph tags, then the public `oembed` endpoint if the page is walled. The
  video id is recovered from whatever names the video — `og:url` / canonical on the
  page, `data-video-id` / `cite` / anchors inside the oEmbed `html` field — so a short
  link that never redirected still lists. No login, no cookies, **no attempt to get
  past a captcha / bot check**: if TikTok returns nothing public, the error says so and
  suggests pasting the long `www.tiktok.com/@…/video/…` address.
* **Classify.** *mini-drama* when the page labels a series/drama itself, or enough of
  these add up: a specific drama hashtag (`#minidrama`, `#shortmax`, `#reelshort`, ...),
  an episode marker in the caption (`EP 12/60`, `Episode 5`, `Part 3`, `Tập 9`,
  `វគ្គ ១២`, `第8集`, ...), membership of a playlist with 3+ videos. A lone `#drama` or a
  lone "Part 2" stays a *normal video*. The verdict, its confidence and the **reasons**
  are shown in the UI.
* **Episode list.** Taken from the playlist data the public page exposes. When the page
  shows only your episode (or `x of N`), the tool says the list is partial instead of
  inventing the rest. For the complete list, point `SOURCE_API_BASE_URL` at a catalog you
  are licensed to use and add `tiktok.com` to `SOURCE_ALLOWED_HOSTS`: the authorized
  extractor then takes over these links (registry position 1).
* **Official listing vs. optional download.** TikTok episodes carry no direct streams and
  are marked `listOnly`; the official/public-page analyzer alone never downloads them.
  An optional, explicitly enabled `tiktok-ssstik` job provider can download those listed
  episodes through SSSTik. If a public playlist exposes several episode URLs, each
  selected episode becomes a separate job item and is sent separately — the whole series
  is walked one post at a time, pinned to `concurrency: 1` because SSSTik rate-limits
  per IP. See
  [the SSSTik section](#optional-third-party-ssstik-downloader-whole-series-opt-in).

> TikTok's page layout is not a public contract. The readers are defensive and covered by
> fixtures, but if a real page stops yielding a playlist the result degrades to the
> single-episode listing above rather than to wrong data.

### Optional third-party SSSTik downloader (whole series; opt-in)

The app includes an unofficial adapter for the public SSSTik form flow, reverse-engineered
from SSSTik's own published client-side bundle and cross-checked against third-party clients
from [2023](https://github.com/krypton-byte/tiktok-downloader/blob/master/tiktok_downloader/ssstik.py)
and [2024](https://github.com/ibnusyawall/ssstik.io-scrapper/blob/main/index.js). The full
teardown — request contract, the 19 backend signals, the CDN wrapping scheme and the
monetisation layer — is in [`docs/research/ssstik-frontend-analysis.md`](docs/research/ssstik-frontend-analysis.md).

Per episode:

```text
GET  https://ssstik.io/            -> read the single-use `s_tt` / `tt` page token
POST https://ssstik.io/abc?url=dl  -> id=<post url>&locale=en&tt=<token>   (HTMX form post)
     <- an HTML fragment + an `HX-Trigger` verdict, not JSON
     -> unwrap the media link, then stream one verified MP4 into R2
```

This is **not a TikTok API, not an official SSSTik API, and not a stable contract**.
SSSTik may change, reject, rate-limit, or block requests at any time.

To enable it on a deployment, set the non-secret Worker variables:

```text
TIKTOK_SSTIK_ENABLED=true
TIKTOK_SSTIK_MIN_INTERVAL_MS=1500    # spacing between SSSTik requests in one isolate; 0 = no pacing
TIKTOK_SSTIK_COOLDOWN_SECONDS=12     # wait before retrying a rate-limited post; 0 = retry immediately
```

For these two, `0` is a real setting and is honoured as such — unlike most numeric
vars in this project, where `0` is read as "not configured" and the default applies
(`num()` in `src/env.ts` takes an explicit `minimum` for exactly this reason). A
negative or unparseable value still falls back to the default, and both are clamped
(30000 ms, 120 s). `wrangler.test.jsonc` sets both to `0` so the suite never really
sleeps; the paced behaviour is asserted directly in `test/tiktok-ssstik.test.ts`.

It is off by default and is never the default download provider.

#### Downloading every episode of a series

Analyze the series/playlist link first so the TikTok analyzer lists every episode, then
choose **TikTok via SSSTik**, tick the rights/URL-sharing confirmation, and start the job.
Each listed episode becomes its own job item and is sent to SSSTik separately.

Such a job is **pinned to `concurrency: 1`** regardless of `DEFAULT_CONCURRENCY`: SSSTik
rate-limits per IP (it answers `ssslimitexceed` and asks for ~10 seconds between posts) and
every episode needs a *fresh* single-use token, so parallel items would only collect
rate-limit errors and burn their retry budget. Items still retry through the queue with
backoff, and a rate-limited post is retried once inside the provider after the cooldown.

#### What the provider accepts

One public TikTok **post** per item: `www.tiktok.com/@…/video/<id>`, a `/@…/photo/<id>`
carousel post, a legacy `/v|/embed|/player/v1/<id>` URL, or a TikTok short link
(`vm.` / `vt.` / `/t/` / `/v/`) which SSSTik resolves itself. Post URLs are normalised to
one stable spelling and tracking parameters are stripped before anything leaves the Worker.
Profiles and playlists are rejected — analyze them instead so VTGrab can list the episodes.
The provider never infers additional episodes on its own.

The link is sent to SSSTik, which is a third party. Its short-lived first-party cookie is
used only for its form request; VTGrab sends no TikTok account/session credentials. It does
not solve captchas, bypass logins, work around a bot challenge, or decrypt DRM — on a
challenge or an unexpected format it stops and says so.

#### Unwrapping the media link

SSSTik does not hand out raw TikTok CDN URLs. It re-wraps them behind its own hosts, and
often encodes the real signed URL **base64 into the path** instead of redirecting:

```text
https://ssscdn.io/<locale>/<product>/<base64 of the real URL>
https://tikcdn.io/<product>/a/<base64 of the real URL>
```

Because `/` is part of the base64 alphabet, a long signed URL is split across *several*
path segments (`[2, 6, 171, 76]` for a typical avatar URL), so the segments have to be
rejoined before decoding — scanning only the last segment silently finds nothing for
exactly the long signed URLs that matter. Both forms are handled: path-embedded payloads
are decoded, opaque proxy paths (`/dl/<id>`) are fetched and their redirects followed.
The decoded URL is then put through the same host allow-list and SSRF guard as any other
URL, on every hop.

#### Diagnosing a failed episode

The backend reports what happened through `HX-Trigger`, so failures are specific rather
than a generic "no link found":

| Verdict | Meaning |
|---|---|
| `ssssuccess_wmonly` | only the watermarked version exists; not stored |
| `ssssuccess_slides` | the post is a photo carousel; there is no single MP4 |
| `ssssuccess_music` | audio only; reported as such rather than fetched as an MP4 |
| `sssinvalidlink` | SSSTik did not recognise the link |
| `ssstterror` | the post is private, removed or region-blocked |
| `ssscurlerror` | SSSTik's own fetch of TikTok failed (transient) |
| `sssblockedclient` | this client/IP is blocked; check the deployment egress IP |
| `ssstokenfail` | the page token was rejected (retried once with a fresh token) |
| `ssslimitexceed` | rate-limited (retried once after the cooldown) |

SSSTik's `sssrapidapi*` signals belong to its separate paid HD tier, which VTGrab does not
use; they are deliberately never reported as the reason an episode failed.

The result must be from the media-host allow-list (`ssstik.io`, `ssscdn.io`, `tikcdn.io`,
`tiktok.com` and the regional TikTok/ByteDance CDNs — see `ALLOWED_MEDIA_HOSTS` in
`src/providers/download/ssstik-media.ts`), carry an MP4 `ftyp` signature, and fit within
the 256 MiB limit before it is streamed into R2 through the normal job path.

If `GRAB_ALLOWED_HOSTS` is set, include those hosts (at minimum `tiktok.com`, `ssstik.io`,
`ssscdn.io`, `tikcdn.io`, `tiktokcdn.com`, `tiktokcdn-us.com`, `tiktokcdn-eu.com`,
`bytecdn.com`, `muscdn.com`, `ibytedtos.com`, and `byteoversea.com`) or the host policy
will refuse the request. Keep `GRAB_DENIED_HOSTS` in force as usual.

Use this only for videos you own or are authorized to save, and follow TikTok's, SSSTik's,
and your local rules. The checkbox is a user attestation, not a rights verification
mechanism. Downloading a whole series means sending every episode URL to a third party and
pulling one signed CDN object per episode: check that is permitted before you start.

Offline tests cover token extraction, URL validation and normalisation, base64 unwrapping
(single- and multi-segment), host allow-listing, redirect guarding, signal-to-message
mapping, the rate-limit retry, pacing, and MP4 signature/length validation — but they do
**not** prove that SSSTik currently works. This sandbox's HTTPS connection to SSSTik closes
during the TLS handshake (Cloudflare rejects it), so live end-to-end downloading remains
**unverified**. The standalone probe is available for diagnostics from a machine that can
reach the site:

```bash
npm run probe:ssstik -- 'https://www.tiktok.com/@account/video/1234567890123456789'     # print unwrapped result links only
npm run download:ssstik -- 'https://www.tiktok.com/@account/video/1234567890123456789'  # save ONE MP4 under downloads/
npm run test:probe:ssstik  # offline CLI fixture tests; no remote calls
```

---

## Deployment to Cloudflare

VTGrab is configured in `wrangler.jsonc` to deploy and work **100% out of the box** on Cloudflare Workers — both via **Cloudflare Workers Builds (Git integration)** and via **`npx wrangler deploy`** — without requiring pre-created D1 UUIDs, R2 buckets, Paid Queues, or custom build tokens:

1. **Prebuilt + auto-built SPA assets (`./public`)**:
   - `wrangler.jsonc` sets `"build": { "command": "npm run build:client" }` and `"assets": { "directory": "./public", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": true }`.
   - `./public` is also committed in git so deployments succeed even if a build step is skipped.
2. **Built-in Edge Fallbacks (`src/runtime/fallbacks.ts`)**:
   - When `DB` (D1), `FILES` (R2), or `JOB_QUEUE` (Queues) bindings are not attached in the Cloudflare dashboard, `ensureRuntimeEnv()` automatically supplies Edge-persisted fallbacks (`FallbackD1Database`, `FallbackR2Bucket`, `FallbackQueue` backed by `caches.default` and `ctx.waitUntil`) so analyzing series, running download jobs, and streaming files work immediately.
3. **Automatic D1 Schema Migration (`ensureD1Schema` / `withAutoSchema`)**:
   - Whenever you attach a real Cloudflare D1 database (`DB`), R2 bucket (`FILES`), or Queue (`JOB_QUEUE`) in the Cloudflare dashboard, VTGrab automatically switches to those bindings and initializes all D1 tables and indexes on the first request — no manual `wrangler d1 migrations apply` required.

### Option A — Deploy from the Cloudflare dashboard (Workers Builds / Git integration)

`Workers & Pages → vtgrabing → Settings → Build`:

| Setting          | Value                   | Why                                                                 |
| ---------------- | ----------------------- | ------------------------------------------------------------------- |
| Git branch       | `main`                  | production branch                                                   |
| Build command    | `npm run build`         | optional (`npx wrangler deploy` also runs `npm run build:client` automatically) |
| Deploy command   | `npx wrangler deploy`   | or `npm run deploy`                                                 |
| Root directory   | `/`                     | `wrangler.jsonc` sits at the root of the repository                 |

Push a commit to `main` (or click **Retry build**) — the Worker builds and deploys cleanly with the default Workers Builds token on both Free and Paid plans.

### Option B — Deploy from your machine (CLI)

```bash
npm install
npx wrangler login
npm run deploy
```

### Optional: Attach dedicated D1 / R2 / Queue resources

If you want dedicated Cloudflare D1 / R2 / Queue resources instead of the built-in Edge fallbacks, you can either attach them in the Cloudflare dashboard (`Workers & Pages → vtgrabing → Settings → Bindings` with names `DB`, `FILES`, `JOB_QUEUE`) or provision them via CLI:

```bash
npm run cf:provision
```

Verify a deployed Worker:

```bash
curl https://<your-worker>.workers.dev/api/health
curl https://<your-worker>.workers.dev/api/sources
```

Environment specific config can be added with
[Wrangler environments](https://developers.cloudflare.com/wrangler/environments/)
(`npx wrangler deploy --env staging`).

---

## Environment variables & secrets

| name                       | kind   | default                     | meaning                                                                 |
| -------------------------- | ------ | --------------------------- | ----------------------------------------------------------------------- |
| `ENVIRONMENT`              | var    | `production`                | appears on `/api/sources` and in the UI badge                            |
| `MOCK_ENABLED`             | var    | `false`                     | **dev only** – enables `MockExtractor` + `MockDownloadProvider`           |
| `MAX_ATTEMPTS`             | var    | `3`                         | attempts per job item before it is marked `failed`                       |
| `DEFAULT_QUALITY`          | var    | `1080p`                     | default quality for new jobs                                             |
| `DEFAULT_CONTAINER`        | var    | `mp4`                       | default container/extension                                              |
| `DEFAULT_CONCURRENCY`      | var    | `4`                         | in-flight downloads per job (also capped by the queue consumer)          |
| `STALE_ITEM_MINUTES`       | var    | `20`                        | when the cron starts polling/failing a `downloading` item                |
| `QUEUE_PUSH_BATCH_SIZE`    | var    | `100`                       | messages per `sendBatch()` (Queues hard limit is 100)                    |
| `SOURCE_ALLOWED_HOSTS`     | var    | `""`                        | comma separated host allow-list for the authorized extractor             |
| `GRAB_ENABLED`             | var    | `true`                      | real link grabber on/off (see [Real link grabbing](#real-link-grabbing)) |
| `GRAB_ALLOWED_HOSTS`       | var    | `""`                        | hosts the grabber may open; empty = any public host                     |
| `PUBLIC_BASE_URL`          | var    | `""`                        | public origin of this Worker (used to build callback URLs)               |
| `SOURCE_API_BASE_URL`      | var    | –                           | root URL of the authorized catalog API (`…/v1/series`)                   |
| `SOURCE_API_TOKEN`         | secret | –                           | `Authorization: Bearer …` for the catalog API                            |
| `DOWNLOAD_SERVICE_URL`     | var    | –                           | root URL of the authorized download service (`…/v1/downloads`)           |
| `DOWNLOAD_SERVICE_TOKEN`   | secret | –                           | `Authorization: Bearer …` for the download service                       |
| `DOWNLOAD_CALLBACK_SECRET` | secret | –                           | HMAC-SHA256 secret for callbacks **and** the maintenance endpoint token   |
| `DOWNLOAD_CALLBACK_URL`    | var    | –                           | override of the callback origin (behind a proxy / custom domain)         |

Bindings: `DB` (D1), `FILES` (R2), `JOB_QUEUE` (Queues producer + consumer).

---

## HTTP API

| method  | path                                          | description                                              |
| ------- | --------------------------------------------- | -------------------------------------------------------- |
| `GET`   | `/api/health`                                 | liveness + D1 reachability                                |
| `GET`   | `/api/sources`                                | extractor/provider availability, limits, binding status   |
| `GET`   | `/api/providers`                              | default provider + descriptors (used by the UI)           |
| `POST`  | `/api/analyze`                                | `{ url, sourceKey?, refresh? }` → series + episodes       |
| `GET`   | `/api/series?q=&limit=&offset=`               | list series                                               |
| `GET`   | `/api/series/:id`                             | series + episodes                                         |
| `GET`   | `/api/series/:id/episodes`                    | episodes only                                             |
| `DELETE`| `/api/series/:id`                             | delete a series (cascades to episodes/jobs)               |
| `POST`  | `/api/jobs`                                   | `{ seriesId, selection, options? }` → job + items (201)   |
| `GET`   | `/api/jobs?status=&seriesId=&limit=&offset=`  | list jobs with counters                                   |
| `GET`   | `/api/jobs/:id`                               | job + items + series                                      |
| `GET`   | `/api/jobs/:id/events`                        | audit log                                                 |
| `POST`  | `/api/jobs/:id/cancel`                        | cancel open items (+ remote cancel)                       |
| `POST`  | `/api/jobs/:id/retry`                         | re-queue `failed`/`cancelled` items                       |
| `GET`   | `/api/files?jobId=&seriesId=&limit=&offset=`  | list stored files                                         |
| `GET`   | `/api/files/:id`                              | file metadata + download URL                              |
| `GET`   | `/api/files/:id/content`                      | stream from R2 (supports `Range`)                         |
| `DELETE`| `/api/files/:id`                              | delete R2 object + row, release the job item              |
| `PUT`   | `/api/internal/provider/callback/:jobItemId`  | **internal** – download service pushes the finished object |
| `POST`  | `/api/internal/maintenance`                   | **internal** – run the cron work now (`Bearer <secret>`)   |

Selection payloads accepted by `POST /api/jobs`:

```jsonc
{ "mode": "all" }
{ "mode": "ids",   "episodeIds": ["ep_…", "ep_…"] }
{ "mode": "range", "from": 2, "to": 12 }        // 1-based, inclusive, order independent
```

Options: `{ quality, container, concurrency, prefix, provider? }`.

Errors are always `{"error":{"code","message","details?"}}` with
`400 / 401 / 404 / 409 / 422 / 503`.

---

## Authorized source integration (extractor contract)

Implement `SourceExtractor` (`src/providers/extract/types.ts`) or, without code
changes, point `AuthorizedHttpExtractor` at an HTTP service you are allowed to
call:

```
GET {SOURCE_API_BASE_URL}/v1/series?url={seriesUrl}
Authorization: Bearer {SOURCE_API_TOKEN}
Accept: application/json
```

```jsonc
{
  "id": "src_123",
  "title": "Series title",
  "synopsis": "…",            // optional
  "posterUrl": "https://…",   // optional
  "canonicalUrl": "…",        // optional, defaults to "authorized-http:<id>"
  "episodes": [
    {
      "index": 1,
      "title": "Episode 1",
      "url": "https://…/episode/1",
      "durationSeconds": 2640,                                   // optional
      "thumbnailUrl": "https://…",                               // optional
      "streams": [                                               // optional
        { "quality": "1080p", "container": "mp4", "bitrateKbps": 5200,
          "url": "https://cdn…/1080p.mp4", "codecs": "avc1.640028" }
      ],
      "metadata": {}                                             // optional
    }
  ],
  "metadata": {}
}
```

The response is validated with `authorizedSeriesResponseSchema`
(`src/providers/extract/authorized.ts`); a schema violation or a non-2xx status
surfaces as a real API error, never as a silently empty series. Hosts must be
listed in `SOURCE_ALLOWED_HOSTS` before the extractor will call them.

---

## Authorized download service (provider contract)

`RemoteDownloadProvider` (`src/providers/download/remote.ts`) speaks this
protocol. Every outbound request carries
`Authorization: Bearer {DOWNLOAD_SERVICE_TOKEN}` **and**
`X-VTGrab-Timestamp` + `X-VTGrab-Signature: sha256=<hmac-sha256 of "{ts}.{body}">`.

**1. Submit**

```
POST {DOWNLOAD_SERVICE_URL}/v1/downloads
{
  "jobItemId": "jit_…", "jobId": "job_…",
  "callbackUrl": "https://<worker>/api/internal/provider/callback/jit_…?expires=…&sig=sha256%3D…",
  "callbackMethod": "PUT", "callbackHeaders": { "content-type": "application/octet-stream" },
  "objectKey": "vtgrab/series/S01E01-episode-1.mp4",
  "quality": "1080p", "container": "mp4",
  "series":  { "id": "ser_…", "title": "…" },
  "episode": { "id": "ep_…", "index": 1, "title": "…", "url": "https://…", "streamUrl": "https://cdn…" }
}
```

Responses:

* `202 {"providerJobId": "pj_1", "status": "queued"}` → deferred; completion
  arrives through the callback **or** through polling.
* `200 {"providerJobId": "pj_1", "status": "ready", "downloadUrl": "https://…"}`
  → the Worker streams `downloadUrl` into R2 immediately.

**2. Callback (push)** — `PUT` the raw bytes to `callbackUrl`. The signature is an
HMAC-SHA256 over `"{jobItemId}.{expires}"`; the service may also send
`X-VTGrab-Ref: <providerJobId>`. The Worker verifies the signature and expiry,
streams the body into R2 (multipart), inserts the `files` row and completes the
item. Retried callbacks are idempotent.

**3. Poll (pull)** — `GET {DOWNLOAD_SERVICE_URL}/v1/downloads/{providerJobId}`
returns `{"status": "queued|running|ready|failed|cancelled", "progress"?, "downloadUrl"?, "bytes"?, "contentType"?, "error"?}`.
The `*/5 * * * *` cron calls this for items that have been `downloading` longer
than `STALE_ITEM_MINUTES`, streams `downloadUrl` into R2 when `ready`, and fails
the item after `4 × STALE_ITEM_MINUTES`.

**4. Cancel** — `DELETE {DOWNLOAD_SERVICE_URL}/v1/downloads/{providerJobId}` is
called for every in-flight item when a user cancels a job.

---

## Runtime limitations of Workers and how this design handles them

Cloudflare Workers **cannot** do what a desktop grabber does:

| Limitation                                                     | Consequence                              | How VTGrab handles it                                                                 |
| -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| No filesystem, no child processes (no `ffmpeg`, no `yt-dlp`)    | media can not be muxed/transcoded locally | heavy work is delegated to `DOWNLOAD_SERVICE_URL`; Workers only orchestrate             |
| ~128 MB memory per isolate                                     | a 4 GB file can not be buffered          | `writeStreamToR2()` streams 8 MiB parts into an R2 multipart upload                     |
| Per-request CPU/wall-clock limits                              | long downloads would be killed           | work is split into one queue message per episode, with retry + backoff                  |
| No outbound TCP sockets                                        | no custom protocols                      | all provider traffic is plain HTTPS `fetch`                                             |
| Queues is at-least-once                                        | duplicate deliveries                     | every handler re-reads D1 before mutating; `files` has a UNIQUE `(bucket, object_key)`  |
| Concurrency is not configurable per message                    | thundering herd on R2 / the provider     | `job.options.concurrency` is enforced by the consumer itself (re-queue with `delaySeconds`) |

The integration boundary is therefore a **deployable HTTP contract**, not a fake
local implementation: `MockDownloadProvider` is used only when
`MOCK_ENABLED=true`, and on a production deployment with no
`DOWNLOAD_SERVICE_URL` the API answers `503 not_configured` instead of pretending
to download something.

---

## Testing

```bash
npm test          # vitest run
npm run test:watch
npm run verify:grab   # real end-to-end grab: fixture site + Worker + SHA-256 of stored bytes
```

The suite runs **inside the Workers runtime** with
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
against real local D1, R2 and Queue bindings (config: `wrangler.test.jsonc`,
migrations applied in `test/setup.ts`). It covers:

* analyze → D1 persistence, caching, validation, unauthorized-source rejection
* selection resolution (`all` / `ids` / `range`, shift-click ranges)
* job creation for selected / range / all episodes, counters, invalid payloads
* the **queue consumer** really downloading, writing to R2 and completing jobs
* cancel → retry → completion, audit events, conflict handling
* R2 streaming writer: single put, 20 MiB multipart (byte-exact), empty stream
* file download endpoint: content, `Range` requests, delete (R2 + D1)
* HMAC signing/verification, signed callback URLs
* the authorized extractor contract (allow-list, Bearer request, response schema)
* the remote provider contract (submit → poll → stream to R2, maintenance sweep,
  timeout failure)
* the real grabber: SSRF/host policy, page sniffing (every discovery path), HLS and DASH
  manifest reading (variants, `SegmentTimeline`, byte ranges, `#EXT-X-MAP`, keys), quality
  labels and container decisions (`test/grab.test.ts`)
* byte-exact transfer: ranged parts, a short part re-requested, an origin without `Range`
  support, a 404/HTML response refused, segment concatenation, encrypted and live refusal
  (`test/grab-download.test.ts`, with `fetch` replaced by an HTTP-speaking fixture)
* `npm run verify:grab` drives the whole thing through the real Worker: analyze a page,
  queue everything it found, wait for the job, then SHA-256 each stored object against the
  bytes the fixture served (see [Real link grabbing](#real-link-grabbing))

---

## Project layout

```
migrations/            D1 schema (0001_init.sql, 0002_job_events.sql)
src/
  index.ts             Worker entry: fetch + queue + scheduled
  env.ts               bindings & configuration helpers
  routes/api.ts        Hono router (every /api route)
  core/                errors, validation (zod), ids, json, selection, http
  db/repository.ts     every D1 statement, row mappers, counters
  jobs/service.ts      create / cancel / retry / dispatch
  jobs/orchestrator.ts queue handlers, R2 completion, maintenance
  queue/               message schema + consumer
  grab/                the real grabber: host policy, HTTP budget, sniffing, HLS/DASH
                       readers, ranged + segmented byte transfer
  providers/extract/   SourceExtractor: tiktok + http-sniff (real) + mock + authorized HTTP
  providers/download/  DownloadProvider: http-stream (real) + mock + remote service
  providers/storage/   streaming R2 writer (multipart)
  providers/signature.ts  HMAC-SHA256 request signing
  frontend/            Vite SPA (index.html, app.ts, api.ts, styles.css)
  shared/types.ts      domain types used by both bundles
scripts/               fixture site + end-to-end grab verification + deploy config check
test/                  vitest-pool-workers suite
test-frontend/         jsdom tests for the SPA
```

---

## Khmer summary (សង្ខេបជាភាសាខ្មែរ)

VTGrab ជា app ពិតដែលដំណើរការលើ **Cloudflare Workers** ដោយប្រើ **D1** (ទុក
metadata), **R2** (ទុក file) និង **Queues** (ដំណើរការ job)។

លំហូរការងារ៖

1. បញ្ចូល URL → **Analyze** → Worker បើក URL នោះ**ពិតប្រាកដ** (HTTP GET) រើស
   វីដេអូទាំងអស់ដែលមានក្នុងទំព័រ (`<video>`/`<source>`, `<a href>`, og:video,
   data-*, player config, JSON-LD) តាម iframe player និងតំណ episode ទាំងអស់
   រួច **បញ្ចូលវីដេអូដែលរកឃើញទាំងអស់ចូល queue** (មួយ item ក្នុងមួយវីដេអូ)
   ហើយទុក series + episodes ចូល D1។ លទ្ធផលមិនមែនជាទិន្នន័យគំរូទេ៖
   quality, duration, ចំនួន segment, ទំហំ និង "encrypted" មកពីការឆ្លើយតប
   របស់ host ពិត។ (Authorized catalog API ដែលអ្នកមានសិទ្ធអាចប្រើជំនួស
   បាន; MockExtractor មានតែពេល `MOCK_ENABLED=true` សម្រាប់ dev/test។)
2. ជ្រើស episode (checkbox, shift-click, ជួរ `from–to`, Select all, Deselect
   all, Invert) → បង្កើត **job**។ Job និង job item ត្រូវបានសរសេរចូល D1 ក្នុង
   transaction តែមួយ ហើយផ្ញើ queue message មួយក្នុងមួយ episode។
3. **Queue consumer** ទាញយក byte ពិតៗ (progressive = `Range` chunk, HLS/DASH =
   segments តាមលំដាប់ playlist) សរសេរ object ចូល R2 (stream ជា 8 MiB multipart)
   បង្កើត row ក្នុង `files` ហើយធ្វើបច្ចុប្បន្នភាព progress។ មាន retry, cancel,
   concurrency limiter និង cron សម្រាប់តាមដាន job ដែលយឺត។
4. Frontend បង្ហាញស្ថានភាពពិតពី backend (pending, downloading, completed,
   failed, cancelled) ដោយ auto-refresh រៀងរាល់ 2 វិនាទី ហើយអាចទាញយក file ពី
   R2 តាម `/api/files/:id/content`។

ចំណុចសំខាន់៖ VTGrab **មិនរំលង DRM** — វីដេអូដែលមាន `#EXT-X-KEY` ឬ
`ContentProtection` ត្រូវបង្ហាញឈ្មោះ ប៉ុន្តែមិនដាក់ក្នុង queue ទេ, ហើយមិន
មានការបញ្ចូល cookie/token ដើម្បីមើលវីដេអូដែលត្រូវបង់ប្រាក់។ មូលហេតុ
ទាំងនេះបង្ហាញក្នុង UI និងក្នុង job event ដោយត្រង់ៗ (មិនបាត់ស្ងាត់ទេ)។

* **MockExtractor / MockDownloadProvider ប្រើតែសម្រាប់ local dev
និង test ប៉ុណ្ណោះ** (បិទដោយ `MOCK_ENABLED=false`)។ វាបង្កើតទិន្នន័យសំយោគ
(synthetic) ដែលសរសេរចំណាយថា "NOT REAL MEDIA" — មិនមែនការទាញយកវីដេអូពិតទេ។
Production ប្រើ service ខាងក្រៅដែលមានការអនុញ្ញាត ( catalog API + download
service) តាម HTTP contract និង HMAC signature ដែលមានចែងក្នុង README នេះ។

ពាក្យបញ្ជាសំខាន់ៗ៖

```bash
npm install
npm run dev      # http://localhost:8787 (ប្រើ D1/R2/Queues ក្នុងម៉ាស៊ីន)
npm test
npm run build
npm run deploy   # build + wrangler deploy
```

**ចំណុចសម្រាប់ deploy តាម Cloudflare dashboard (Workers Builds):**

* ក្នុង `Settings → Build` មិនមាន ចន្លោះ «ជ្រើស folder / build output directory» ទេ
  (ចន្លោះនោះមានតែក្នុង Cloudflare **Pages** ប៉ុណ្ណោះ)។ សម្រាប់ Worker វាយ៉ាង
  ដែលត្រូវ upload កំណត់ក្នុង `wrangler.jsonc` ថា `assets.directory: "./dist"`
  ហើយ **build command** ជាអ្នកបង្កើត folder នោះ (ព្រោះ `dist/` មិនមានក្នុង git)។
* ដូច្នេះ៖ Build command = `npm run build`, Deploy command = `npm run deploy`,
  Root directory = `/` (ព្រោះ `wrangler.jsonc` នៅឫសរៀងខាងលើរបស់ repo)។
* ត្រូវបង្កើត resource ទាំង៣ ក្នុង Cloudflare dashboard៖
  `Storage & Databases → D1 → Create` ឈ្មោះ `vtgrab-db`,
  `R2 → Create bucket` ឈ្មោះ `vtgrab-files`,
  `Queues → Create queue` ឈ្មោះ `vtgrab-jobs`។
  រួចចម្លង **database ID** របស់ `vtgrab-db` (UUID) ដាក់ជំនួស `00000000-…`
  ក្នុង `wrangler.jsonc` ហើយ commit — Cloudflare build ខាងប្រាកដនឹងដំណើរការ។
* ឬឲ្យ script ធ្វើឲ្យ៖ `npx wrangler login` ម្តង រួច `npm run cf:provision`
  (បង្កើតទាំង៣ + សរសេរ database_id ចូល `wrangler.jsonc`) ហើយ
  `npm run db:migrate`។ ពិនិត្យមុន push៖ `npm run cf:check`។

---

## License

MIT — see the deployment and integration notes above before pointing this at a
real catalog: only use sources you are authorized to access.
