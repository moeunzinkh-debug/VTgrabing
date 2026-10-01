# SSSTik.io — Frontend / Protocol Teardown (research notes)

> **Scope & method.** This is an analysis of *publicly served* client-side assets only:
> `https://ssstik.io/js/script_ssstik.min.js` (retrieved from Internet Archive snapshots
> `20240120062021` and `20250715185749`), the public homepage text, and three independent
> open-source clients that document the same form flow. Nothing here was obtained by
> bypassing a protection, and nothing here describes how to defeat one. Where SSSTik's
> server applies a bot challenge, the correct behaviour is to **stop**, which is what
> `src/providers/download/tiktok-ssstik.ts` already does.
>
> Date of research: 2026-10-01. The live sandbox could not open a TLS session to
> `ssstik.io` (Cloudflare rejects the handshake), so all findings below come from
> archived/first-party-published assets rather than a live capture.

---

## 1. High-level architecture

SSSTik is a **server-rendered, HTMX-driven** app. There is no SPA framework, no JSON API,
and no client-side extraction logic. The browser is deliberately dumb:

```
                 ┌────────────────────────────────────────────────────────┐
  Browser        │  static shell (HTML + CSS)                             │
                 │  script_ssstik.min.js  = htmx 1.6.0                    │
                 │                        + MicroModal                    │
                 │                        + "include-vals" htmx extension │
                 │                        + ads/telemetry glue            │
                 └───────────────┬────────────────────────────────────────┘
                                 │ POST /abc?url=dl   (form-urlencoded, returns an HTML *fragment*)
                                 ▼
                 ┌────────────────────────────────────────────────────────┐
  Origin         │  Cloudflare (WAF + JS challenge + Rocket Loader)       │
                 └───────────────┬────────────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────────────┐
  Backend        │  1. validate `tt` page token                           │
                 │  2. resolve the TikTok post server-side                │
                 │  3. render result fragment + emit a body event          │
                 │  4. re-wrap media URLs behind ssscdn.io / tikcdn.io     │
                 └───────────────┬────────────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────────────┐
  Media          │  ssscdn.io / tikcdn.io  → 302 or path-embedded base64  │
                 │  → real signed *.tiktokcdn.com / ibytedtos.com URL      │
                 └────────────────────────────────────────────────────────┘
```

Key insight: **all the interesting work happens on their server.** The frontend only
(a) collects a URL, (b) carries a page token, (c) swaps in an HTML fragment, and
(d) runs a fairly large advertising/telemetry layer.

---

## 2. Asset inventory

| Asset | Role | Notes |
|---|---|---|
| `/js/script_ssstik.min.js` | The one application bundle | Versioned by query string, e.g. `?v=1.20250713.1`. Cache-busted almost weekly — ~70 distinct versions archived between 2023-12 and 2025-07. |
| `/js/htmx.min.js` | Also shipped standalone | Bundle embeds **htmx 1.6.0** (`version:"1.6.0"` literal in source). |
| `/js/micromodal.min.js` | Modal dialogs | Used for the iOS "vignette" app-promo interstitial. |
| `/js/accordion.min.js` | FAQ accordion | `?v=1.0.1`. |
| `/cdn-cgi/scripts/.../rocket-loader.min.js` | Cloudflare Rocket Loader | Defers/reorders their own scripts. |
| `/cdn-cgi/challenge-platform/...` | Cloudflare JS challenge | Present in archived captures from 2024-04 and 2024-07. |

The bundle is a single concatenated, minified file: *their glue code* → *htmx* →
*include-vals extension* → *MicroModal*.

---

## 3. The request/response contract

### 3.1 Step 1 — `GET https://ssstik.io/` (or `/en`, `/id`, …)

The server inlines a short-lived **page token** into the HTML:

```js
// documented by ibnusyawall/ssstik.io-scrapper (2024)
const regexSsstikToken = /s_tt\s*=\s*'([^']+)'/;
```

```py
# documented by krypton-byte/tiktok-downloader (2023)
re.findall(r"tt:'([\w\d]+)'", ses.text)[0]
```

So both spellings occur in the wild: a bare `var s_tt = '…'` global and an
`include-vals="tt:'…'"` HTMX attribute. `src/providers/download/tiktok-ssstik.ts`
already matches both:

```ts
/(?:\bs_tt\s*=\s*|\btt\s*:\s*)['"]([\w-]{4,128})['"]/
```

Observed token shape: 6–8 chars of `[\w-]`, e.g. `gfFrG7`, `KWosH6`, `4bNuQ?`,
`dGljelRm`, `RjlGOHU_`. It is **not** a reCAPTCHA token and **not** a Cloudflare
clearance token — it is a per-page-load nonce their backend issues so that a POST
without first loading the shell is rejected.

Other server-inlined globals read by the bundle (all feature flags / config):

| Global | Purpose |
|---|---|
| `s_locale` | Language; `ar` flips the input-button geometry to RTL. |
| `s_idgg` | GTM container id, injected at runtime. |
| `s_gae` | "Google ads enabled" — `0` hides `#ad_main`. |
| `s_prov` | Ad provider override → `window.uadprovider`. |
| `s_dyninj` | Dynamically inject Google Funding Choices script. |
| `s_addadinj` | Inject Ezoic as a fallback when AdSense reports `data-ad-status="unfilled"`. |
| `s_adbl` | Enable ad-block telemetry beacon. |
| `s_n` | Hostname used for the `/cdn-cgi/trace` telemetry call. |
| `s_ven` | Which custom "vignette" (app-promo interstitial) to show on success. |
| `s_slook` | Enable Smartlook session recording (iOS only). |
| `window.partnerAlerts` | Base64 map of "wrong site" messages (`unknown`, `instagram`, …). |
| `window.uadclient` | Ad client/slot ids. |

### 3.2 Step 2 — `POST https://ssstik.io/abc?url=dl`

Body: `application/x-www-form-urlencoded`

```
id=<the tiktok url>&locale=en&tt=<page token>
```

Headers the real browser sends (HTMX sets these automatically):

```
hx-request: true
hx-trigger: _gcaptcha_pt
hx-target: target
hx-current-url: https://ssstik.io/en
origin: https://ssstik.io
referer: https://ssstik.io/en
content-type: application/x-www-form-urlencoded; charset=UTF-8
```

Two details worth noting:

* `hx-trigger: _gcaptcha_pt` is a **custom HTMX event name**, not a reCAPTCHA token.
  The `_g` + `captcha_pt` naming implies the submit is gated on a Google captcha
  "passthrough"/score event; the backend fires `ssstokenfail` when it is unhappy.
* The `include-vals` HTMX extension present in the bundle does
  `valuesToInclude = eval("({" + includeVals + "})")` — i.e. **`include-vals`
  attributes are `eval`'d**. That is how `tt:'…'` gets merged into the POST body, and
  it is why HTMX's `allowEval: true` config is left on.

### 3.3 Step 3 — the response is an HTML *fragment*, not JSON

htmx swaps it into `#target`. Server-driven state is communicated by a **custom event
on `<body>`** (`hx-trigger`/`HX-Trigger` response header). The bundle listens for the
full set, which effectively enumerates every backend outcome:

| Event | Meaning | Client reaction |
|---|---|---|
| `ssssuccess` | Generic success | splash → success, show vignette |
| `ssssuccess_video` | MP4 available | `body.response-success` |
| `ssssuccess_videoandmp3` | MP4 **and** MP3 | + ad-block check |
| `ssssuccess_slides` | Photo/carousel post | no vignette |
| `ssssuccess_music` | Audio only | |
| `ssssuccess_wmonly` | **Only watermarked** version obtainable | |
| `ssssuccess_scraptik` | Fulfilment via their "scraptik" path | |
| `sssinvalidlink` | URL not recognised | splash → error |
| `ssstterror` | TikTok-side extraction error | splash → error |
| `ssscurlerror` | Their server's outbound fetch failed | `bigmessage = "Unforeseen consequences"` |
| `sssblockedclient` | Client/IP blocked | splash → error |
| `ssstokenfail` | Page token rejected | `location.href = pathname + "?" + e.detail.value` (reload with a server hint) |
| `sssfailure` | Catch-all failure | |
| `ssslimitexceed` | Rate limit | `"You are making requests too fast! Please wait ~10 seconds..."` |
| `sssrapidapisuccess` | **HD** link ready | `#hd_download` → "HD link is ready!" |
| `sssrapidapifail` | HD failed | button → `#f2cb2f` |
| `sssrapidapifakehd` | Source isn't really HD | button → grey + `disabled` |
| `sssrapidapittfail` | HD token failure | button → `#ff2200` + `disabled` |

The `sssrapidapi*` family reveals a **second, paid-upstream tier**: the watermark-free
link comes from their own scraper, but the "HD" button is served through a RapidAPI
reseller, and they explicitly detect and disable the button when the upstream only has
fake/upscaled HD.

### 3.4 Fragment DOM the client scrapes

From `ibnusyawall/ssstik.io-scrapper` (cheerio selectors against the real fragment):

```js
username    = $('h2').text()
description = $('.maintext').text()
likeCount   = $('div.trending-actions > div.justify-content-start').eq(0).text()
commentCount= $('div.trending-actions > div.justify-content-center > div').text()
shareCount  = $('div.trending-actions > div.justify-content-end > div').text()
avatarUrl   = $('img.result_author').attr('src')
videoUrl    = $('a.without_watermark').attr('href')   // ← the MP4
musicUrl    = $('a.music').attr('href')               // ← the MP3
overlayUrl  = /#mainpicture .result_overlay\s*{\s*background-image:\s*url\(["']?([^"']+)/   // from an inline <style>
```

Download anchors carry the full class chain:

```
a.pure-button.pure-button-primary.is-center.u-bl.dl-button.download_link.without_watermark.vignette_active.notranslate
a.pure-button.pure-button-primary.is-center.u-bl.dl-button.download_link.music.vignette_active.notranslate
```

`vignette_active` is what their click handler uses to decide whether to pop the
app-promo interstitial before navigating.

---

## 4. The media-URL wrapping scheme (important)

SSSTik does **not** hand out raw TikTok CDN URLs in the fragment. It re-wraps them
behind its own CDN hosts, and the real target is **base64-encoded into the path**:

```
https://ssscdn.io/<locale>/<product>/<base64(real target url)>
https://tikcdn.io/<product>/a/<base64(real target url)>
```

Verified decodes:

```
https://ssscdn.io/en/ssstik/aHR0cHM6Ly93d3cudGlrdG9rLmNvbS9AbWVldm4vcGhvdG8vNzQzNTIwODMyNzI0OTkzOTcxMw==
  → https://www.tiktok.com/@meevn/photo/7435208327249939713

https://tikcdn.io/ssstik/a/aHR0cHM6Ly9wMTYtYW1kLXZhLnRpa3Rva2Nkbi5jb20v…dD0yMjM0NDljNA
  → https://p16-amd-va.tiktokcdn.com/tos-maliva-avt-0068/4b9daa…~tplv-tiktokx-cropcenter-q:100:100:q75.webp
      ?dr=8835&idc=useast5&nonce=26013&ps=87d6e48a&refresh_token=1b5265bb…&s=AWEME_DETAIL&sc=avatar&shcp=1d1a97fc&shp=45126217&t=223449c4
```

Consequences:

1. The decoded URL is a **fully signed, time-limited** TikTok CDN URL (`refresh_token`,
   `nonce`, `t`, `ps`, `idc`). It expires — you must fetch promptly, not cache.
2. Base64 padding (`=`) is preserved in the path, so the segment is *not* URL-safe
   base64; krypton-byte's client normalises with `'/'.join(x.split('/')[5:])`.
3. Some links are proxy-redirects (fetch → 302 → real URL) and some are
   path-embedded (decode locally). A robust client must handle both.

`scripts/ssstik-download.mjs` and `src/providers/download/tiktok-ssstik.ts` currently
follow redirects (case 3a) but **do not** decode the path-embedded form (case 3b).
See §7.

---

## 5. Client-side input validation

Their `keyup` handler on `#main_page_text`:

```js
link.trim().match(".*http(s|)://.*(tiktok|xzcs3zlph).com/.*/.*")
```

* `xzcs3zlph.com` is TikTok's alternate short-link domain — worth knowing because
  share links from some regions use it and our `isTikTokHost()` allow-list does not.
* If the host matches, `#submit` gets `disabled` — HTMX/the captcha flow takes over.
* If it does **not** match, they show a base64-decoded message from
  `window.partnerAlerts` (per-platform: `instagram`, `unknown`, plus strings steering
  Reddit/YouTube users to sister properties). This is a **traffic-referral funnel**,
  not just error handling: the same operator runs a family of sibling downloaders and
  the alert text cross-promotes them.

---

## 6. Monetisation & telemetry layer

This is genuinely the largest part of the bundle, and it explains several design choices.

**Ad stack (layered fallbacks):**
1. Google AdSense — A/B split across **four** publisher accounts, chosen per page load:
   ```js
   const rand = Math.floor(100 * Math.random()) + 1;
   clients = { ssstik:      ["9873762851395779", …],   // default
               ssstik_back: ["8948135330327270", …],   // 2024: rand 51–96 · 2025: rand == 96
               ssstik3:     ["7647406474707126", …],   // rand 1–3 (2024) / 1–2 (2025)
               ssstik4:     ["1730393708785684", …] }; // rand 97–100
   ```
   Randomising the serving account across four `ca-pub-` ids is a classic
   **AdSense ban/limit-risk distribution** pattern.
2. Google Funding Choices (`fundingchoicesmessages.google.com/i/ca-pub-<id>`) injected
   when `s_dyninj == 1`.
3. Ezoic (`gatekeeperconsent.com/cmp.min.js`, `cmp.gatekeeperconsent.com/min.js`,
   `ezoic/sa.min.js`, `ezstandalone.showAds(119)`) — injected only when AdSense reports
   `data-ad-status="unfilled"`, detected with a `MutationObserver` + 8 s timeout
   (`waitForElmAttr`).
4. Ad-block detection: `XMLHttpRequest.HEAD` to `pagead2.googlesyndication.com/pagead/js/adsbygoogle.js`
   and compare `xhr.responseURL`. If blocked **and** an HD button exists, they remove
   `#hd_download` and print *"Please disable your Adblock to download HD quality videos!"* —
   i.e. **HD is gated behind ads**.

**Telemetry:**
* GTM (`s_idgg`) with a rich `dataLayer` event schema (`{event:'success',status:'videoandmp3'}`,
  `{event:'error',status:'curl_error'}`, `{event:'adblock',status:'detected'}`…). The
  full event list in §3.3 doubles as their funnel analytics.
* When `s_adbl != 0`, after a successful video download they `fetch('//'+s_n+'/cdn-cgi/trace')`,
  regex out `loc=`, `ip=`, `warp=`, `uag=`, and `POST /log/e` with
  `ab=&loc=&warp=&uag=&ip=`. So: **visitor country, IP, WARP status and UA are
  collected and sent to a first-party logging endpoint** after each success.
* Smartlook session recording on iOS when `s_slook == 1`:
  `smartlook('init','575bbd5711ac4d68f9d831b79b552ca7988dc644',{region:'eu'})`,
  `smartlook('record',{forms:true, numbers:true, emails:false, ips:true})`.

**App funnel:**
* Android package names are also A/B split, and the 2025 build adds a third variant:
  ```js
  android_apps = { appdl:     "com.video.videodownloader_appdl",
                   lite:      "com.video.videodownloader_appdl_lite",   // new in 2025, rand 21–100
                   universal: "com.universal.video.downloader" };
  ```
* iOS gets a MicroModal "vignette" interstitial (App Store deep link) plus a
  `htmx.ajax('POST','/vignette/event?close', …)` beacon when dismissed, and a
  native-redirect fallback that navigates to the ad's `href` after 2 s.

---

## 7. What this means for VTGrab

Concrete gaps found by comparing the teardown against our current adapter:

Status: **items 1–6 and 8 are implemented**; item 7 stays deliberately out of scope.

| # | Finding | Status | Where |
|---|---|---|---|
| 1 | `ssscdn.io` / `tikcdn.io` wrap the real URL as **path-embedded base64** | ✅ Implemented | `unwrapMediaUrl()` in `src/providers/download/ssstik-media.ts` (mirrored for the CLI in `scripts/lib/ssstik-media.mjs`). The decoded URL is re-run through the host allow-list *and* the SSRF guard on every hop. |
| 1b | …and `/` is in the base64 alphabet, so long payloads span **several** path segments | ✅ Implemented (found while building #1) | `unwrapMediaUrl()` rejoins candidate spans longest-first. A last-segment-only scan silently finds nothing for exactly the long signed URLs that matter; covered by a test that asserts the segment count so it cannot rot. |
| 2 | `tikcdn.io` is a live media host (2025 captures) | ✅ Implemented | `ALLOWED_MEDIA_HOSTS` now includes `tikcdn.io` plus the regional CDNs (`tiktokcdn-eu.com`, `byteicdn.com`, `bytefcdn.net`, `ibyteimg.com`, `tiktokcdnv.com`). Refusals name the rejected host and whether it came from a decode. |
| 3 | `xzcs3zlph.com` is accepted by *their* validator as a TikTok host | ✅ Handled explicitly | `isTikTokOrAltHost()` accepts it for input, but `validatePostUrl()` still requires an identifiable post/short link, so a bare alt-host URL gets a specific message rather than a generic one. |
| 4 | Backend distinguishes `wmonly` / `slides` / `music` / `scraptik` outcomes | ✅ Implemented | `parseSsstikSignal()` + `describeSignal()` map all 19 `HX-Trigger` signals onto distinct messages; audio-only markup without a signal is reported separately. `sssrapidapi*` (their paid HD tier) is excluded so it is never blamed for a missing MP4. |
| 5 | `ssstokenfail` is a **retryable** state (server hints a reload) | ✅ Implemented | One extra shell+POST round with a fresh token, capped by `MAX_FORM_ATTEMPTS` and `Budget`. |
| 6 | `ssslimitexceed` ≈ 10 s cooldown | ✅ Implemented | `TIKTOK_SSTIK_COOLDOWN_SECONDS` (default 12) before the single in-provider retry; `TIKTOK_SSTIK_MIN_INTERVAL_MS` paces every request; `buildJobOptions()` pins SSSTik jobs to `concurrency: 1` so a whole series is walked serially. |
| 7 | HD tier is a separate RapidAPI upstream gated behind ad-block detection | ⛔ Out of scope on purpose | Requires their ad/HD flow. Our MP4 path already verifies `ftyp`; chasing "HD" would mean driving their interstitials. |
| 8 | Signed CDN URLs carry `refresh_token`/`nonce`/`t` and expire | ✅ Already correct | `cf: { cacheTtl: 0 }`, streamed straight into R2, URL never persisted. |

Three bugs were found and fixed while implementing the above, all of which a
last-segment-only or truthiness-based reading would have shipped:

* **Multi-segment base64** (1b) — the wrapper path splits the payload, so decoding
  only the final segment returns `null` and the episode fails as "no MP4 link found".
* **Falsy-zero retry** — `if (mapped?.retryAfterSeconds)` skips the retry entirely when
  the cooldown is configured to `0`. Now `typeof … === 'number'`.
* **Zero never reached the config reader** — `num(env, key, fallback)` only accepted
  `parsed > 0`, so `TIKTOK_SSTIK_COOLDOWN_SECONDS=0` and `TIKTOK_SSTIK_MIN_INTERVAL_MS=0`
  were silently discarded and the defaults applied. Fixing the retry gate alone would
  still have left `0` meaningless, and the test suite (which sets both to `0` in
  `wrangler.test.jsonc`) would have really slept 1.5 s per request and 12 s per retry.
  `num()` now takes an explicit `minimum` that defaults to `1`, keeping `0` = "not
  configured" for every var that would break on a zero (`MAX_ATTEMPTS`,
  `QUEUE_PUSH_BATCH_SIZE`, `GRAB_MAX_REDIRECTS`, `STALE_ITEM_MINUTES`) and letting only
  the two settings where zero is meaningful opt in. Verified inert for all 17
  pre-existing keys.

**Things we should deliberately NOT copy:**

* Do not send `ip`/`loc`/`uag` telemetry of our users anywhere.
* Do not randomise anything to distribute risk across accounts — we have one account.
* Do not `eval` attribute strings (their `include-vals` extension does).
* Do not attempt the `_gcaptcha_pt` gate, the Cloudflare challenge, or the HD tier.
  Our adapter's "stop honestly on a challenge" behaviour is the right design and should
  stay the default (`TIKTOK_SSTIK_ENABLED=false`).

---

## 8. Sources

* `https://web.archive.org/web/20240120062021id_/https://ssstik.io/js/script_ssstik.min.js`
* `https://web.archive.org/web/20250715185749id_/https://ssstik.io/js/script_ssstik.min.js?v=1.20250713.1`
* Wayback CDX index for `ssstik.io*` (asset inventory, `/abc` capture history)
* `https://github.com/krypton-byte/tiktok-downloader/blob/master/tiktok_downloader/ssstik.py` (2023 client: token regex, headers, `ssscdn.io` base64 path)
* `https://github.com/ibnusyawall/ssstik.io-scrapper/blob/main/index.js` (2024 client: `s_tt` regex, fragment selectors)
* `https://gist.github.com/Tanmyname-py/578ba7e6f6a3e3bded61270241b72052` (2025 client: `tikcdn.io` responses, anchor class chains)
* Existing in-repo adapter: `src/providers/download/tiktok-ssstik.ts`, `scripts/probe-ssstik.mjs`
