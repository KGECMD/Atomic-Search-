// metasearch_scraper.js — Background job that scrapes top result URLs from
// meta search providers and feeds them into the crawler queue, growing the
// Atomic index organically without requiring user searches.
//
// Enabled only when ENABLE_METASEARCH=1 is set. Respects robots.txt via
// a simple in-memory cache and applies per-domain rate limiting so we
// never hammer any single provider.
//
// Env vars:
//   ENABLE_METASEARCH   Set to "1" to enable (default: off).
//   METASEARCH_INTERVAL Interval in seconds between scrape rounds (default: 1800 = 30 min).
//   METASEARCH_QUERIES  Comma-separated seed queries (default: built-in list).

import { enqueueCrawl } from "./storage.js";
import { isSafeUrl } from "./safeurl.js";
import { isNsfwUrl } from "./nsfw.js";
import { normaliseUrl, privateFetch } from "./util.js";

const ENABLED = (typeof process !== "undefined" && process.env?.ENABLE_METASEARCH) === "1";
const INTERVAL_MS = Math.max(
  300_000, // floor: 5 minutes
  (Number(process.env?.METASEARCH_INTERVAL) || 1800) * 1000
);

// Seed queries used when METASEARCH_QUERIES is not set.
const DEFAULT_QUERIES = [
  "open source software",
  "privacy tools linux",
  "web development tutorial",
  "machine learning python",
  "self hosting guide",
  "rust programming language",
  "typescript best practices",
  "docker kubernetes tutorial",
  "vim neovim setup",
  "cryptography explained",
  "distributed systems",
  "database design patterns",
  "api design rest graphql",
  "security hardening linux",
  "network protocols explained",
];

// Robots.txt cache: domain → { allowed: bool, fetchedAt: number }
const robotsCache = new Map();
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function isAllowedByRobots(url) {
  try {
    const u = new URL(url);
    const domain = u.origin;
    const cached = robotsCache.get(domain);
    if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
      return cached.allowed;
    }
    const robotsUrl = `${domain}/robots.txt`;
    const res = await privateFetch(robotsUrl, {
      timeout: 3000,
      headers: { "User-Agent": "AtomicSearch/1.0 (+https://atomic-search.com)" },
    }).catch(() => null);
    if (!res || !res.ok) {
      robotsCache.set(domain, { allowed: true, fetchedAt: Date.now() });
      return true;
    }
    const text = await res.text().catch(() => "");
    // Simple check: look for Disallow: / under User-agent: * or AtomicSearch
    const lines = text.split("\n").map((l) => l.trim().toLowerCase());
    let inOurAgent = false;
    let inStar = false;
    let starDisallowAll = false;
    let ourDisallowAll = false;
    for (const line of lines) {
      if (line.startsWith("user-agent:")) {
        const agent = line.replace("user-agent:", "").trim();
        inOurAgent = agent === "atomicsearch" || agent === "atomic";
        inStar = agent === "*";
      }
      if (line.startsWith("disallow:")) {
        const path = line.replace("disallow:", "").trim();
        if (path === "/" || path === "") {
          if (inOurAgent) ourDisallowAll = true;
          if (inStar) starDisallowAll = true;
        }
      }
    }
    const allowed = !ourDisallowAll && !starDisallowAll;
    robotsCache.set(domain, { allowed, fetchedAt: Date.now() });
    return allowed;
  } catch {
    return true; // default allow on error
  }
}

// Per-domain rate limiting: track last scrape time per domain.
const domainLastScrape = new Map();
const DOMAIN_MIN_GAP_MS = 10_000; // 10 seconds between requests to same domain

async function waitForDomainSlot(domain) {
  const last = domainLastScrape.get(domain) || 0;
  const wait = DOMAIN_MIN_GAP_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  domainLastScrape.set(domain, Date.now());
}

// Extract URLs from a DuckDuckGo HTML response (lite endpoint).
function extractDDGUrls(html) {
  const urls = [];
  // DDG lite returns result links as href="/l/?uddg=<encoded-url>"
  const re = /href="\/l\/\?uddg=([^"&]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (decoded.startsWith("http")) urls.push(decoded);
    } catch { /* ignore */ }
  }
  return urls;
}

// Extract URLs from a Brave Search HTML response.
function extractBraveUrls(html) {
  const urls = [];
  // Brave result links appear as data-url="https://..."
  const re = /data-url="(https?:\/\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.push(m[1]);
  }
  // Also try href patterns for result cards
  const re2 = /class="[^"]*result[^"]*"[^>]*href="(https?:\/\/[^"]+)"/g;
  while ((m = re2.exec(html)) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

// Scrape a single query from DuckDuckGo Lite (most permissive for bots).
async function scrapeDDG(query) {
  const domain = "html.duckduckgo.com";
  await waitForDomainSlot(domain);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await privateFetch(url, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AtomicSearch/1.0; +https://atomic-search.com)",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    return extractDDGUrls(html).slice(0, 15);
  } catch {
    return [];
  }
}

// Scrape a single query from Brave Search.
async function scrapeBrave(query) {
  const domain = "search.brave.com";
  await waitForDomainSlot(domain);
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  try {
    const res = await privateFetch(url, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AtomicSearch/1.0; +https://atomic-search.com)",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    return extractBraveUrls(html).slice(0, 15);
  } catch {
    return [];
  }
}

// One full scrape round: pick a random subset of queries, scrape each,
// filter URLs, and enqueue them for the crawler.
async function scrapeRound() {
  const rawQueries = process.env?.METASEARCH_QUERIES
    ? process.env.METASEARCH_QUERIES.split(",").map((q) => q.trim()).filter(Boolean)
    : DEFAULT_QUERIES;

  // Pick up to 5 random queries per round to avoid hammering providers.
  const queries = rawQueries
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  let totalEnqueued = 0;
  let totalFound = 0;

  for (const query of queries) {
    // Alternate between providers to spread load.
    const providers = Math.random() > 0.5
      ? [scrapeDDG, scrapeBrave]
      : [scrapeBrave, scrapeDDG];

    for (const scraper of providers) {
      try {
        const urls = await scraper(query);
        totalFound += urls.length;
        for (const rawUrl of urls) {
          try {
            if (!isSafeUrl(rawUrl)) continue;
            if (isNsfwUrl(rawUrl)) continue;
            const allowed = await isAllowedByRobots(rawUrl);
            if (!allowed) continue;
            const norm = normaliseUrl(rawUrl);
            await enqueueCrawl(norm).catch(() => {});
            totalEnqueued++;
          } catch { /* ignore per-URL errors */ }
        }
        // Small gap between providers for the same query.
        await new Promise((r) => setTimeout(r, 2000));
      } catch { /* ignore per-provider errors */ }
    }
    // Gap between queries.
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(
    `[metasearch] round complete: ${queries.length} queries, ` +
    `${totalFound} URLs found, ${totalEnqueued} enqueued`
  );
}

let _started = false;

/**
 * Start the background meta search scraper.
 * No-ops if ENABLE_METASEARCH != "1" or if already started.
 */
export function startMetasearchScraper() {
  if (!ENABLED) return;
  if (_started) return;
  if (typeof process === "undefined" || !process.versions?.node) return;
  _started = true;

  console.log(
    `[metasearch] scraper enabled — interval ${INTERVAL_MS / 1000}s, ` +
    `${DEFAULT_QUERIES.length} seed queries`
  );

  // First run after a short delay so the server is fully up.
  setTimeout(() => {
    scrapeRound().catch((e) => {
      console.warn("[metasearch] first round error:", e?.message || e);
    });
  }, 30_000).unref?.();

  // Subsequent runs on the configured interval.
  setInterval(() => {
    scrapeRound().catch((e) => {
      console.warn("[metasearch] round error:", e?.message || e);
    });
  }, INTERVAL_MS).unref?.();
}
