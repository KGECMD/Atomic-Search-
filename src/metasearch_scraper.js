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
import { normaliseUrl } from "./util.js";

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

// Robots.txt checking is disabled — it was too strict and blocked legitimate
// content discovery. Re-enable by setting METASEARCH_CHECK_ROBOTS=1.
const CHECK_ROBOTS = (typeof process !== "undefined" && process.env?.METASEARCH_CHECK_ROBOTS) === "1";

async function isAllowedByRobots(url) {
  // Disabled by default — always allow.
  if (!CHECK_ROBOTS) return true;
  try {
    const u = new URL(url);
    // Only block if the domain explicitly disallows all crawlers.
    const robotsUrl = `${u.origin}/robots.txt`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "AtomicSearch/1.0 (+https://atomic-search.com)" },
    }).catch(() => null);
    clearTimeout(t);
    if (!res || !res.ok) return true;
    const text = await res.text().catch(() => "");
    const lines = text.split("\n").map((l) => l.trim().toLowerCase());
    let inStar = false;
    for (const line of lines) {
      if (line.startsWith("user-agent:")) {
        inStar = line.replace("user-agent:", "").trim() === "*";
      }
      if (inStar && line.startsWith("disallow:")) {
        const path = line.replace("disallow:", "").trim();
        if (path === "/") return false;
      }
    }
    return true;
  } catch {
    return true;
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

// Shared fetch helper using native fetch (no privateFetch dependency).
// Applies a timeout and spoofs a browser UA so scraping succeeds.
async function metaFetch(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });
  } finally {
    clearTimeout(t);
  }
}

// Extract URLs from a DuckDuckGo HTML response.
// DDG HTML endpoint encodes result URLs in several ways across versions:
//   1. href="/l/?uddg=<encoded-url>&..." — classic redirect link
//   2. data-url="https://..." — newer layout attribute
//   3. href="https://..." inside .result__a anchors
function extractDDGUrls(html) {
  const urls = [];
  const seen = new Set();

  const addUrl = (u) => {
    try {
      const clean = u.split("&")[0]; // strip extra params
      if (clean.startsWith("http") && !seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    } catch { /* ignore */ }
  };

  // Pattern 1: uddg= redirect parameter (URL-encoded)
  const re1 = /href="\/l\/[^"]*[?&]uddg=([^"&]+)/g;
  let m;
  while ((m = re1.exec(html)) !== null) {
    try { addUrl(decodeURIComponent(m[1])); } catch { /* ignore */ }
  }

  // Pattern 2: data-url attribute
  const re2 = /data-url="(https?:\/\/[^"]+)"/g;
  while ((m = re2.exec(html)) !== null) {
    addUrl(m[1]);
  }

  // Pattern 3: result__a href pointing directly to external URLs
  const re3 = /class="[^"]*result__a[^"]*"[^>]*href="(https?:\/\/[^"]+)"/g;
  while ((m = re3.exec(html)) !== null) {
    addUrl(m[1]);
  }

  // Pattern 4: any href starting with http inside result divs
  const re4 = /<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]{0,500}?href="(https?:\/\/[^"]+)"/g;
  while ((m = re4.exec(html)) !== null) {
    addUrl(m[1]);
  }

  if (urls.length === 0) {
    // Log a snippet of the HTML for debugging when nothing was found.
    console.warn("[metasearch] DDG: 0 URLs extracted. HTML snippet:", html.slice(0, 500));
  }
  return urls;
}

// Extract URLs from a Brave Search HTML response.
// Brave's layout changes frequently; try multiple selector patterns.
function extractBraveUrls(html) {
  const urls = [];
  const seen = new Set();

  const addUrl = (u) => {
    try {
      if (u.startsWith("http") && !seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    } catch { /* ignore */ }
  };

  // Pattern 1: data-url attribute on result containers
  const re1 = /data-url="(https?:\/\/[^"]+)"/g;
  let m;
  while ((m = re1.exec(html)) !== null) addUrl(m[1]);

  // Pattern 2: href inside snippet/result title anchors
  const re2 = /class="[^"]*(?:result-header|snippet-title|title|h)[^"]*"[^>]*href="(https?:\/\/[^"]+)"/g;
  while ((m = re2.exec(html)) !== null) addUrl(m[1]);

  // Pattern 3: href on <a> tags inside article.snippet or div.result
  const re3 = /<(?:article|div)[^>]*class="[^"]*(?:snippet|result)[^"]*"[^>]*>[\s\S]{0,800}?<a[^>]*href="(https?:\/\/[^"]+)"/g;
  while ((m = re3.exec(html)) !== null) addUrl(m[1]);

  // Pattern 4: any external href that looks like a result (not brave.com itself)
  const re4 = /href="(https?:\/\/(?!search\.brave\.com)[^"]{10,})"/g;
  while ((m = re4.exec(html)) !== null) {
    const u = m[1];
    // Skip obvious non-result URLs (ads, navigation, etc.)
    if (/brave\.com|javascript:|#/.test(u)) continue;
    addUrl(u);
  }

  if (urls.length === 0) {
    console.warn("[metasearch] Brave: 0 URLs extracted. HTML snippet:", html.slice(0, 500));
  }
  return urls;
}

// Scrape a single query from DuckDuckGo Lite (most permissive for bots).
async function scrapeDDG(query) {
  const domain = "html.duckduckgo.com";
  await waitForDomainSlot(domain);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;
  console.log(`[metasearch] DDG scraping: "${query}"`);
  try {
    const res = await metaFetch(url);
    if (!res.ok) {
      console.warn(`[metasearch] DDG HTTP ${res.status} for "${query}"`);
      return [];
    }
    const html = await res.text();
    const urls = extractDDGUrls(html).slice(0, 15);
    console.log(`[metasearch] DDG found ${urls.length} URLs for "${query}"`);
    return urls;
  } catch (err) {
    console.warn(`[metasearch] DDG error for "${query}":`, err?.message || err);
    return [];
  }
}

// Scrape a single query from Brave Search.
async function scrapeBrave(query) {
  const domain = "search.brave.com";
  await waitForDomainSlot(domain);
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web&spellcheck=0`;
  console.log(`[metasearch] Brave scraping: "${query}"`);
  try {
    const res = await metaFetch(url);
    if (!res.ok) {
      console.warn(`[metasearch] Brave HTTP ${res.status} for "${query}"`);
      return [];
    }
    const html = await res.text();
    // Detect bot-protection interstitials.
    if (/captcha|challenge|bot.?protection|press.+continue/i.test(html)) {
      console.warn(`[metasearch] Brave bot-protection triggered for "${query}"`);
      return [];
    }
    const urls = extractBraveUrls(html).slice(0, 15);
    console.log(`[metasearch] Brave found ${urls.length} URLs for "${query}"`);
    return urls;
  } catch (err) {
    console.warn(`[metasearch] Brave error for "${query}":`, err?.message || err);
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

  console.log(`[metasearch] starting round with ${queries.length} queries: ${queries.join(", ")}`);

  let totalEnqueued = 0;
  let totalFound = 0;
  let totalSkipped = 0;

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
            if (!isSafeUrl(rawUrl)) { totalSkipped++; continue; }
            if (isNsfwUrl(rawUrl)) { totalSkipped++; continue; }
            const allowed = await isAllowedByRobots(rawUrl);
            if (!allowed) { totalSkipped++; continue; }
            const norm = normaliseUrl(rawUrl);
            await enqueueCrawl(norm).catch(() => {});
            totalEnqueued++;
          } catch (urlErr) {
            console.warn("[metasearch] per-URL error:", urlErr?.message || urlErr);
          }
        }
        // Small gap between providers for the same query.
        await new Promise((r) => setTimeout(r, 2000));
      } catch (provErr) {
        console.warn("[metasearch] provider error:", provErr?.message || provErr);
      }
    }
    // Gap between queries.
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(
    `[metasearch] round complete: ${queries.length} queries, ` +
    `${totalFound} URLs found, ${totalEnqueued} enqueued, ${totalSkipped} skipped`
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
