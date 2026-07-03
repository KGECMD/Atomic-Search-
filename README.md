# Atomic Search

> **Privacy-first search with its own growing index. No trackers, no logs, no history.**

A modern, privacy-first meta-search engine with its own growing anonymous index. Built by [The UCXP Project](https://github.com/kay816577-hue/Atomic-Search-), founded by Kayan Erkama at age 14.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/Node.js->=18-brightgreen)](package.json)
[![Beta](https://img.shields.io/badge/Status-Beta-orange)](https://github.com/kay816577-hue/Atomic-Search-/releases)

---

## ✨ Features

### 🔒 Privacy First
- **Zero trackers** — No cookies, no analytics, no referrer tracking
- **No query logs** — Your searches are never stored
- **Anonymous browsing** — Optional proxy links hide your IP
- **Open source** — 100% MIT licensed, inspect the code yourself

### ⚡ Performance
- **Seven-engine meta search** — Parallel queries to Startpage, Brave, Bing, DuckDuckGo, Wikipedia, Hacker News, and Reddit
- **Smart ranking** — Reciprocal Rank Fusion + BM25 + semantic signals
- **Own growing index** — SQLite-backed crawler builds an index from searches
- **Instant results** — Skeleton loading, optimized rendering

### 🤖 On-Device AI
- **Optional client-side AI** — Uses Qwen2.5-0.5B-Instruct via Transformers.js
- **Private by default** — Model runs entirely in your browser
- **No data leaves your device** — Zero network calls after model download
- **Grounded answers** — AI summaries based on actual search results

### 🎨 Beautiful Design
- **100+ themes** — Dark, light, futuristic, retro, accessibility-focused
- **Premium UI** — Smooth animations, responsive design, WCAG AA accessibility
- **Mobile-first** — Optimized for all screen sizes
- **PWA support** — Install as an app, works offline

### 🛠️ Developer Tools
- **Public API** — Zero-config JSON API at `/api/v1/search`
- **Command palette** — Ctrl/Cmd+K for quick access
- **Keyboard shortcuts** — Full keyboard navigation
- **Voice search** — Web Speech API integration

---

## 🚀 Quick Start

```bash
# Clone the repository
git clone https://github.com/kay816577-hue/Atomic-Search-.git
cd Atomic-Search-

# Install dependencies
npm install

# Start the server
npm start

# Open http://localhost:3000
```

**Requirements:** Node.js ≥ 18

## Self-hosting

Atomic is designed to be self-hosted. Pick a deployment target and follow
the matching section.

### Docker / VPS (recommended for privacy)

```bash
git clone https://github.com/kay816577-hue/Atomic-Search-.git
cd Atomic-Search-
docker build -t atomic-search .
docker run -d --name atomic -p 3000:3000 \
  -v $PWD/data:/data \
  -e DATA_DIR=/data \
  atomic-search
```

Point a reverse proxy (Caddy / nginx / Traefik) at port `3000`. The SQLite
index is stored in the mounted `./data` volume so it survives container
restarts automatically — you don't need the GitHub snapshot mode.

### Render (free tier)

1. Fork this repo to your own GitHub account.
2. Create a new **Web Service** on Render pointing at your fork.
3. `render.yaml` in the repo wires everything up automatically (Node 20,
   `npm install`, `node server.js`).
4. To survive Render's free-tier filesystem wipes, set these env vars on
   the Render service:

   | Variable | Value |
   | --- | --- |
   | `GH_INDEX_PAT` | A GitHub PAT with `contents:write` on your fork |
   | `GH_INDEX_REPO` | `your-user/your-fork` (defaults to the render default) |
   | `GH_INDEX_BRANCH` | `atomic-search-index` (default) |
   | `GH_INDEX_INTERVAL` | `120` (seconds between snapshots, default) |

   With those set, every 2 min the running server commits its SQLite DB
   to the chosen branch. On the next deploy/restart, Atomic restores from
   that branch BEFORE the HTTP server or crawler starts, so the index
   stays in sync across GitHub, the site, and the server forever.

### Vercel

1. Fork this repo.
2. Import it into Vercel. The `api/[[...slug]].js` function handles all
   dynamic routes and `public/` is served statically.
3. Because Vercel serverless functions have no local disk, set the same
   `GH_INDEX_*` env vars as Render above so the index lives on the data
   branch. The function reads it on cold start.

### Cloudflare Pages

1. Fork this repo.
2. Create a new Cloudflare Pages project pointed at it. `wrangler.toml` +
   `functions/[[path]].js` handle the routing.
3. Cloudflare Workers don't currently support better-sqlite3; the Atomic
   index runs in the LRU-cache fallback mode only. Meta-search and the
   anonymous proxy work fine. If you want a persistent own-index on
   Cloudflare, deploy the Render/VPS flavour instead.

### Generate a GitHub PAT

The restart-safe index persistence needs a fine-grained PAT:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → **Generate new token**.
2. Repository access: only the fork you're deploying (e.g. `your-user/Atomic-Search-`).
3. Repository permissions → **Contents: Read and write**.
4. Copy the token and paste it into `GH_INDEX_PAT` on Render / Vercel.

The token is only used to push the SQLite file. It is never exposed to
clients, never logged, and never used for anything else.

### Full environment variable reference (all optional)

| Variable | Purpose |
| --- | --- |
| `VIRUSTOTAL_API_KEY` | Enables URL + download safety checks |
| `GH_INDEX_PAT` | GitHub PAT (`contents:write`) for index persistence |
| `GH_INDEX_REPO` | Override the repo used for snapshots |
| `GH_INDEX_BRANCH` | Branch name for snapshots (default `atomic-search-index`) |
| `GH_INDEX_INTERVAL` | Snapshot interval in seconds (default 120 = 2 min) |
| `ENABLE_MARGINALIA` | Set to `1` to also query the Marginalia small-web engine |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | "Continue with Google" sign-in. Redirect URI: `https://<host>/api/auth/google/callback` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Email magic-link sign-in |
| `ATOMIC_SESSION_SECRET` | Long random string for signing session cookies |
| `HF_API_TOKEN` / `OPENAI_API_KEY` / `OPENAI_API_BASE` / `OPENAI_MODEL` | Optional AI backends |
| `DATA_DIR` | Where to put the SQLite DB (default `./data`) |
| `PORT` | Server port (default 3000) |

Without any of these, Atomic still runs end-to-end — just without safety
badges, sign-in, or cross-restart persistence.

## How the index works

1. You search. Atomic fans out across seven engines in parallel — all with
   spoofed UA, no cookies, no referrer — and combines the results.
2. Results are rank-fused, de-duplicated, keyword-scored, and popular-site-
   weighted. Any strong matches from our own indexed pages are promoted
   to the top and visually badged.
3. The top result URLs are added to the crawl queue. A background worker
   pulls from that queue every 5 seconds, fetches the page, strips it to
   plain text, and writes it to SQLite. Stale pages (>14 days old) are
   re-crawled hourly.
4. Every `GH_INDEX_INTERVAL` seconds (default 120 = 2 min) the SQLite
   file is committed + pushed to the data branch of the configured repo.
   On boot, `startIndexSync()` runs BEFORE the HTTP server or crawler
   start, so the index is always restored to the latest good snapshot
   before anyone can write to it.
5. Submitting a URL via the Submit dialog crawls it eagerly and kicks an
   immediate snapshot, so "add → it's in our index → it's on GitHub"
   holds within the next tick, not the next interval.

The net result: the on-GitHub snapshot, the running server, and the live
site are always in sync — even across Render's free-tier deploy wipes.

## Terms of Service

_Last updated: 2026. These terms apply to atomicsearch. and the UCXP Project/KGEcmd and any other
deployment of this codebase. They describe what the software does and the
promises it actually keeps._

By using Atomic Search you agree that:

1. **Atomic is provided "as is"**, with no warranty. It is a meta-search
   engine; the result quality depends on public upstream engines we do
   not control. If an upstream engine blocks us, some queries may return
   fewer results until its self-healing tracker resets.
2. **Atomic does not own the content of indexed pages.** Titles and short
   extracts are cached for re-ranking only. You must respect the
   copyright of any page you visit via Atomic.
3. **No illegal use.** Don't use Atomic to search for, distribute, or
   scan material that is illegal in your jurisdiction. Attempting to use
   the safety scanner to confirm that malware runs is prohibited.
4. **No scraping of Atomic itself.** The `/api/search` endpoint is
   rate-limited. Persistent abuse may result in your IP's request being
   throttled (we hash it in memory, we never store it).
5. **Self-hosted deployments are your responsibility.** Operators of a
   fork must comply with their own local law and, if they enable
   sign-in, inform their users about data retention appropriate to
   their deployment.

The source code is released under the MIT license; see `LICENSE`.

## Privacy Notice

_Last updated: 2026. This notice is what the code actually does today.
If you find a discrepancy, it is a bug — open an issue._

### What Atomic DOES NOT store

- **Search queries.** Your query is passed to the upstream engines at
  request time and discarded. There is no query log, no SQL table of
  searches, no file written to disk containing queries.
- **IP addresses.** We do not log or persist the IP address of any
  search request. The rate limiter keeps a short-lived in-memory token
  bucket keyed by a SHA-256 hash of the IP; the bucket is evicted on
  idle and never written to disk.
- **User-Agent or Referer strings** of incoming requests.
- **Analytics cookies.** Atomic sets zero cookies unless you are signed
  in — in which case the only cookie is a session token (HMAC-signed,
  HTTP-only, SameSite=Lax, expires).
- **Third-party trackers.** The frontend loads only assets served from
  the same origin.

### What Atomic DOES store

- **The crawl index** — page URLs, titles, plain-text extracts, and a
  timestamp — for the subset of pages it indexes. This is the "our
  own index" that powers ranking. No per-user information is attached
  to any indexed page.
- **Submitted URLs.** If you click "Submit a URL", the URL is kept so
  the crawler can prioritise it. Your IP is not associated with the
  submission.
- **Safety-scan verdicts.** Hash-keyed verdicts from VirusTotal are
  cached (up to 24 h per URL / file hash) so we don't re-hit the API.

### Outbound behaviour

- Atomic fetches upstream engines from its server, with a generic
  Firefox User-Agent, no cookies, no Referer, and a hard timeout. The
  upstream engines see Atomic's IP, not yours.
- Clicks on results can optionally route through `/go` (a safety
  interstitial) or `/proxy` (an anonymous HTML proxy). Both drop your
  IP, referrer, and cookies before the outbound fetch.



### SSRF + sandbox guarantees

The `/proxy` and `/api/scan/file` endpoints refuse to fetch:
`localhost`, `127.0.0.0/8`, `169.254.0.0/16` (including the cloud
metadata IP `169.254.169.254`), `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, IPv6 loopback/ULA/link-local, and any non-HTTP(S)
scheme. See `src/safeurl.js`.

### Data that IS persisted to GitHub

The SQLite index (`atomic.db`) is periodically snapshotted to the
`atomic-search-index` branch of the configured repo. This snapshot
contains indexed pages only — no query log, no IP, no user data. If
you delete the branch, the next boot starts with an empty index.

## Changelog

### v3.2.0 — "Ultimate Production Upgrade"
- **Premium UI/UX** — Complete visual overhaul with smooth animations, skeleton loading, enhanced cards
- **Performance** — Service worker caching, PWA support, optimized rendering
- **Search Quality** — Typo tolerance, query intent detection, fuzzy phrase matching, site: operator
- **Accessibility** — WCAG AA compliance, keyboard navigation, screen reader support
- **20+ New Features** — Easter eggs, toast notifications, enhanced keyboard shortcuts, new themes
- **Security** — CSP headers, XSS protection, rate limiting improvements

### v3.1.0 — "3rd Anniversary"
- 100+ themes including retro, nature, anime, gaming, accessibility
- Better ranking algorithm with sliding-window proximity
- Faster indexing with bloom filter persistence
- Index Health badge
- New API endpoints

### v3.0.0 — Major Rewrite
- Complete UI redesign
- Seven-engine meta search
- Own crawl index
- GitHub-based index persistence
- On-device AI mode

## Credits

**Atomic Search** is developed by **The UCXP Project**, founded in 2023 by **Kayan Erkama** at the age of 14.

Built with:
- [Hono](https://hono.dev/) — lightweight web framework
- [SQLite](https://www.sqlite.org/) — embedded database
- [Transformers.js](https://huggingface.co/docs/transformers.js) — client-side ML

## License

MIT.

---

*Made with ❤️ for privacy*
