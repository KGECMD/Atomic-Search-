// Parental controls — age-based content filtering.
//
// Privacy-first: all filtering is done locally, no external API calls, no
// user data is logged. The age group is a UI preference stored in
// localStorage — it is never sent to the server.
//
// Age groups:
//   "all"  — no filtering (default for adult users)
//   "13+"  — removes adult/NSFW content; keeps teen-appropriate material
//   "18+"  — same as "all" but with explicit NSFW domains blocked
//
// The blocklist is intentionally conservative. We only block domains that
// are unambiguously adult/NSFW — not anything edgy or controversial.

// ---------------------------------------------------------------------------
// Domain blocklist
// ---------------------------------------------------------------------------

// Domains that are blocked for all age-restricted groups ("13+" and "18+").
// This list is intentionally short and conservative. The full NSFW domain
// list lives in src/nsfw.js — this is a supplementary layer for the
// parental-controls feature specifically.
const BLOCKED_DOMAINS_13_PLUS = new Set([
  "pornhub.com",
  "xvideos.com",
  "xnxx.com",
  "xhamster.com",
  "redtube.com",
  "youporn.com",
  "tube8.com",
  "spankbang.com",
  "eporner.com",
  "tnaflix.com",
  "beeg.com",
  "drtuber.com",
  "nuvid.com",
  "txxx.com",
  "hclips.com",
  "hdzog.com",
  "porntrex.com",
  "fuq.com",
  "4tube.com",
  "slutload.com",
  "xtube.com",
  "keezmovies.com",
  "fapdu.com",
  "empflix.com",
  "porndig.com",
  "onlyfans.com",
  "fansly.com",
  "manyvids.com",
  "clips4sale.com",
  "adultfriendfinder.com",
  "ashleymadison.com",
  "chaturbate.com",
  "cam4.com",
  "myfreecams.com",
  "stripchat.com",
  "bongacams.com",
  "livejasmin.com",
  "camsoda.com",
  "flirt4free.com",
]);

// Keywords that indicate adult/NSFW content. Used for text-based filtering
// when domain matching alone is insufficient. Conservative list — only
// unambiguous adult terms.
const NSFW_KEYWORDS_13_PLUS = [
  "pornography", "pornographic", "xxx", "adult content",
  "explicit sexual", "nude photos", "naked videos",
  "sex tape", "erotic fiction", "hentai",
];

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Normalise a URL to its hostname for domain matching.
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Check whether a domain is blocked for a given age group.
 * @param {string} host  - Hostname (without www.)
 * @param {string} ageGroup  - "all" | "13+" | "18+"
 * @returns {boolean}
 */
function isDomainBlocked(host, ageGroup) {
  if (!host || ageGroup === "all") return false;
  // Both "13+" and "18+" block the same domain list.
  if (BLOCKED_DOMAINS_13_PLUS.has(host)) return true;
  // Also block subdomains of blocked domains.
  for (const blocked of BLOCKED_DOMAINS_13_PLUS) {
    if (host.endsWith("." + blocked)) return true;
  }
  return false;
}

/**
 * Check whether a piece of content (title + text) is safe for a given age
 * group using keyword matching. Returns true if the content is safe to show.
 *
 * @param {string} title
 * @param {string} text
 * @param {string} ageGroup  - "all" | "13+" | "18+"
 * @returns {boolean}
 */
export function isContentSafe(title, text, ageGroup) {
  if (!ageGroup || ageGroup === "all") return true;
  const combined = ((title || "") + " " + (text || "")).toLowerCase();
  for (const kw of NSFW_KEYWORDS_13_PLUS) {
    if (combined.includes(kw)) return false;
  }
  return true;
}

/**
 * Filter a list of search results by age group. Results from blocked domains
 * or containing unsafe content are removed. The original array is not mutated.
 *
 * @param {Array}  results   - Array of result objects with at least { url, title, text }
 * @param {string} ageGroup  - "all" | "13+" | "18+"
 * @returns {Array}
 */
export function filterByAge(results, ageGroup) {
  if (!ageGroup || ageGroup === "all") return results || [];
  return (results || []).filter((r) => {
    if (!r || !r.url) return false;
    const host = hostOf(r.url);
    if (isDomainBlocked(host, ageGroup)) return false;
    if (!isContentSafe(r.title, r.text || r.snippet, ageGroup)) return false;
    return true;
  });
}
