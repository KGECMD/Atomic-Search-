// Principled ranking for Atomic Search.
//
// Every signal is a pure function that returns a value in [0, 1], so the
// final score is a transparent weighted sum. This file carries ALL the
// ranking math so the call-sites (aggregator.js) stay declarative.
//
// Signals (each 0..1):
//   bm25        : BM25-style title+snippet relevance vs query tokens
//   titleMatch  : exact / prefix / coverage bonus on the (brand-stripped) title
//   authority   : POPULAR_HOSTS tier normalised (0, 0.33, 0.66, 1.0)
//   structure   : homepage / shallow-path / deep-path prior
//   agreement   : cross-source agreement (how many engines returned this URL)
//   rrf         : normalised reciprocal-rank-fusion of upstream positions
//
// Weights sum to 1. Changing weights is a one-line edit; every signal is
// independently unit-testable (see ranking.test.js).

export const WEIGHTS = Object.freeze({
  bm25: 0.32,
  titleMatch: 0.25,
  agreement: 0.08,
  authority: 0.15,
  rrf: 0.05,
  structure: 0.07,
  proximity: 0.08, // v5: phrase-proximity bonus in snippet
});

// v5 "parked / ad-heavy" host demotion. Appearing here reduces the final
// score by up to PARKED_PENALTY. Conservative — only genuinely content-
// free hosts belong here.
const PARKED_HOSTS = new Set([
  "example.com", "example.org", "example.net",
  "parking.namebright.com", "sedoparking.com", "parking-page.com",
  "domainmarket.com", "godaddy.com",
  "hugedomains.com", "ww1.godaddy.com",
  "buydomains.com", "dan.com",
  "blogspot.com", // hostnames that are entirely parked land here only when
  // the full domain matches; per-subdomain exceptions are handled via the
  // allow-list in aggregator.js rather than by listing every subdomain.
]);
const PARKED_PENALTY = 0.35;

export function parkedDemote(host) {
  if (!host) return 0;
  const h = host.toLowerCase().replace(/^www\./, "");
  return PARKED_HOSTS.has(h) ? PARKED_PENALTY : 0;
}

// Tiny synonym table that demonstrably helps short queries. Additions
// should be conservative — every entry widens BM25 recall.
const SYNONYMS = {
  docs: ["documentation", "doc"],
  documentation: ["docs"],
  js: ["javascript"],
  javascript: ["js"],
  ts: ["typescript"],
  typescript: ["ts"],
  py: ["python"],
  python: ["py"],
  rs: ["rust"],
  go: ["golang"],
  golang: ["go"],
  k8s: ["kubernetes"],
  kubernetes: ["k8s"],
  postgres: ["postgresql"],
  postgresql: ["postgres"],
  psql: ["postgresql", "postgres"],
  gh: ["github"],
  so: ["stackoverflow"],
};

const STOPWORDS = new Set([
  "the", "a", "an", "of", "is", "are", "to", "in", "on", "for", "and", "or",
  "it", "be", "was", "were", "by", "at", "as", "this", "that", "with",
  "from", "what", "who", "why", "how", "do", "does", "did",
]);

// Titles often include a site suffix. Strip it before exact-match checks.
const TITLE_SUFFIX_RE =
  /\s*[|\-–—·:]\s*(wikipedia(?:,\s*the\s*free\s*encyclopedia)?|wiki|mdn\s*web\s*docs|mdn|github|docs|documentation|official\s*site|home\s*page|home|blog)\s*$/i;

export function stripTitleBrand(t) {
  return (t || "").replace(TITLE_SUFFIX_RE, "").trim();
}

export function tokenise(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function buildQueryContext(query) {
  const all = tokenise(query);
  const meaningful = all.filter((t) => !STOPWORDS.has(t) && t.length >= 2);
  const tokens = meaningful.length ? meaningful : all;
  return {
    raw: (query || "").trim(),
    phrase: tokens.join(" "),
    tokens,
    tokenSet: new Set(tokens),
  };
}

// ---------- individual signals ----------

// BM25-ish saturation scoring. We don't carry a real IDF corpus (no fixed
// vocabulary; public engines give us snippets on demand) so we collapse to
// term-frequency saturation with title vs snippet field weighting.
// Returns a value in [0, 1].
const BM25_K1 = 1.2;
const BM25_B = 0.75;           // field-length normalisation factor
const BM25_TITLE_W = 4.0;      // increased from 3.0 — title is the strongest signal
const BM25_SNIPPET_W = 1.0;
// Approximate average field lengths (in tokens) used for BM25b normalisation.
// These are corpus-level constants; exact values matter less than the ratio.
const AVG_TITLE_LEN = 8;
const AVG_SNIPPET_LEN = 60;

function termFrequency(text, token) {
  if (!text || !token) return 0;
  // Word-boundary-ish match so "linux" doesn't spuriously hit "linuxmint".
  // We accept prefix matches ("react" in "reactive") because search
  // snippets are short and prefix matching is usually what users want.
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(token)}`, "giu");
  const m = text.match(re);
  return m ? m.length : 0;
}

// Generate conservative stem variants for a token: trailing-s drop/add,
// common -ing/-ed endings. Returns an array that always includes the
// original. Each variant is matched with a reduced weight so "running"
// doesn't dominate "run" but still scores.
function variantsFor(token) {
  const out = new Set([token]);
  const syns = SYNONYMS[token];
  if (syns) for (const s of syns) out.add(s);
  // Plural/singular
  if (token.length > 3) {
    if (token.endsWith("ies")) out.add(token.slice(0, -3) + "y");
    else if (token.endsWith("es")) out.add(token.slice(0, -2));
    else if (token.endsWith("s")) out.add(token.slice(0, -1));
    else out.add(token + "s");
  }
  // ing / ed
  if (token.length > 5 && token.endsWith("ing")) out.add(token.slice(0, -3));
  if (token.length > 4 && token.endsWith("ed")) out.add(token.slice(0, -2));
  return Array.from(out);
}

// Highest term-frequency across any variant of the token. We don't sum
// across variants because that would over-reward multi-form occurrences
// (we want "docs" and "documentation" to count roughly the same).
function tfWithVariants(text, token) {
  const variants = variantsFor(token);
  let best = 0;
  for (const v of variants) {
    const tf = termFrequency(text, v);
    if (tf > best) best = tf;
  }
  return best;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function bm25Score(item, ctx) {
  const tokens = ctx.tokens;
  if (!tokens.length) return 0;
  const title = stripTitleBrand((item.title || "").toLowerCase());
  const snippet = (item.snippet || item.text || "").toLowerCase();
  // Field lengths in tokens for BM25b normalisation.
  const titleLen = Math.max(1, title.split(/\s+/).filter(Boolean).length);
  const snippetLen = Math.max(1, snippet.split(/\s+/).filter(Boolean).length);
  let sum = 0;
  for (const tok of tokens) {
    const tfT = tfWithVariants(title, tok);
    const tfS = tfWithVariants(snippet, tok);
    // BM25b: normalise TF by field length relative to corpus average.
    const normT = BM25_K1 * (1 - BM25_B + BM25_B * (titleLen / AVG_TITLE_LEN));
    const normS = BM25_K1 * (1 - BM25_B + BM25_B * (snippetLen / AVG_SNIPPET_LEN));
    const satT = tfT / (tfT + normT);   // → [0,1)
    const satS = tfS / (tfS + normS);   // → [0,1)
    sum += BM25_TITLE_W * satT + BM25_SNIPPET_W * satS;
  }
  // Normalise by max possible saturation sum:
  //   perfect = (W_title + W_snippet) * tokens.length  (every token
  //   saturating both fields). Dividing keeps us in [0,1].
  const maxPossible = (BM25_TITLE_W + BM25_SNIPPET_W) * tokens.length;
  return clamp01(sum / maxPossible);
}

export function titleMatchScore(item, ctx) {
  const title = stripTitleBrand((item.title || "").toLowerCase());
  if (!title || !ctx.tokens.length) return 0;
  const phrase = ctx.phrase;

  // Exact match (after brand strip) is the strongest signal.
  if (title === phrase) return 1;
  if (title.startsWith(phrase + " ") || title.startsWith(phrase + ":")) return 0.85;
  if (title.endsWith(" " + phrase)) return 0.7;

  // Phrase contained anywhere in title.
  if (phrase.length >= 3 && title.includes(phrase)) {
    // Shortness bonus: shorter titles with the phrase are more canonical.
    const tw = title.split(/\s+/).length;
    const qw = ctx.tokens.length;
    const noise = Math.max(0, tw - qw);
    return clamp01(0.55 + 0.15 / (1 + noise * 0.5));
  }

  // Prefix-match bonus: first token of the query matches the start of the
  // title (e.g. query "react" matching "React Documentation"). This is a
  // strong intent signal — the page is explicitly about the queried topic.
  if (ctx.tokens.length >= 1) {
    const firstToken = ctx.tokens[0];
    if (firstToken.length >= 3 && title.startsWith(firstToken)) {
      // Scale by how many other tokens also appear in the title.
      let extraHits = 0;
      for (let i = 1; i < ctx.tokens.length; i++) {
        if (title.includes(ctx.tokens[i])) extraHits += 1;
      }
      const extraCoverage = ctx.tokens.length > 1
        ? extraHits / (ctx.tokens.length - 1)
        : 1;
      return clamp01(0.75 * (0.5 + 0.5 * extraCoverage));
    }
  }

  // Token coverage.
  let hit = 0;
  for (const t of ctx.tokens) if (title.includes(t)) hit++;
  const coverage = hit / ctx.tokens.length;
  // Cap non-phrase title matches at 0.5 so an exact-title always wins.
  return clamp01(coverage * 0.5);
}

// POPULAR_HOSTS tier → authority score in [0,1]. Tiers are injected so
// aggregator.js can keep owning the domain list.
export function authorityScore(tier) {
  const t = Number(tier) || 0;
  if (t >= 3) return 1.0;
  if (t === 2) return 0.66;
  if (t === 1) return 0.33;
  return 0.0;
}

// URL-structure prior. Homepages of sites whose name matches a query token
// (e.g. kernel.org/ for "linux kernel") are the canonical entry point and
// deserve a lift. Deep paths are neutral.
export function structureScore(url, ctx) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const isHome = (path === "" || path === "/") && !u.search;
    const root = host.split(".").slice(-2)[0] || host;
    const hostMatchesQuery = ctx.tokens.some(
      (t) => t.length >= 3 && (root === t || host.split(".").includes(t))
    );
    if (isHome && hostMatchesQuery) return 1.0;
    if (isHome) return 0.5;
    // Shallow path (≤2 segments) is slightly preferred for canonical pages.
    const depth = path.split("/").filter(Boolean).length;
    if (depth <= 2) return 0.2;
    return 0.0;
  } catch { return 0.0; }
}

// Cross-source agreement: how many distinct engines returned this URL,
// normalised against a soft "plenty" threshold of 4.
export function agreementScore(nEngines) {
  const n = Math.max(1, Number(nEngines) || 1);
  if (n <= 1) return 0.0;
  return clamp01(Math.log2(n) / 2); // 2 engines → 0.5, 4 → 1.0
}

// Normalised RRF score. `rrfRaw` is the raw RRF sum we computed across
// engines for this URL; `rrfMax` is the maximum observed in this set.
export function rrfNormalised(rrfRaw, rrfMax) {
  if (!rrfMax) return 0;
  return clamp01(rrfRaw / rrfMax);
}

// v5: phrase-proximity score. Rewards results where query tokens appear
// close to each other in the snippet (indicates the passage is actually
// about the query, not just incidentally mentioning each word). Returns
// a value in [0, 1].
export function proximityScore(item, ctx) {
  const tokens = ctx.tokens;
  if (tokens.length < 2) return 0; // single-token queries get neutral 0

  const text = ((item.title || "") + " " + (item.snippet || item.text || "")).toLowerCase();
  if (!text) return 0;

  // Find the first occurrence of each token. If any is missing, no
  // proximity bonus.
  const positions = [];
  for (const tok of tokens) {
    const variants = variantsForExport(tok);
    let best = -1;
    for (const v of variants) {
      const idx = text.indexOf(v);
      if (idx >= 0 && (best < 0 || idx < best)) best = idx;
    }
    if (best < 0) return 0;
    positions.push(best);
  }

  positions.sort((a, b) => a - b);
  const span = positions[positions.length - 1] - positions[0];
  // Perfect proximity (span of 0..40 chars) → 1. 150+ → 0 (tighter than
  // the old 300-char threshold — a 150-char window is roughly one sentence,
  // which is a much stronger signal that the passage is actually about the
  // query).
  if (span <= 40) return 1;
  if (span >= 150) return 0;
  return clamp01(1 - (span - 40) / 110);
}

// Freshness bonus: pages indexed in the last 7 days get a 0.1 boost;
// older pages decay linearly to 0 over 90 days. Returns a value in [0, 1].
export function freshnessScore(indexedAt) {
  const age = Math.max(0, Date.now() - (indexedAt || 0));
  const sevenDays = 7 * 24 * 3600 * 1000;
  const ninetyDays = 90 * 24 * 3600 * 1000;
  if (age <= sevenDays) return 0.1;
  if (age >= ninetyDays) return 0;
  return clamp01(0.1 * (1 - (age - sevenDays) / (ninetyDays - sevenDays)));
}

// Domain reputation boost: .edu, .gov, and .org TLDs are generally more
// authoritative than commercial domains. Returns 0.15 for boosted TLDs,
// 0 otherwise. Intentionally conservative — only TLD-level, not per-host.
export function domainReputationScore(host) {
  if (!host) return 0;
  const h = host.toLowerCase().replace(/^www\./, "");
  if (h.endsWith(".edu") || h.endsWith(".gov") || h.endsWith(".org")) return 0.15;
  return 0;
}

// Snippet quality penalty: snippets that are mostly ellipses or very short
// are low-quality (truncated, boilerplate, or auto-generated). Returns a
// value in [0, 1] where 1 is a clean snippet and 0 is heavily penalised.
export function snippetQualityScore(snippet) {
  const s = (snippet || "").trim();
  if (!s || s.length < 20) return 0;
  // Count ellipsis occurrences (both "..." and "…").
  const ellipsisCount = (s.match(/\.{3}|…/g) || []).length;
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  // Penalise if more than 20% of "words" are ellipses, or if there are
  // more than 3 ellipses in a short snippet.
  const ellipsisRatio = ellipsisCount / Math.max(1, wordCount);
  if (ellipsisRatio > 0.2 || (ellipsisCount > 3 && wordCount < 30)) {
    return clamp01(1 - ellipsisRatio * 2);
  }
  return 1;
}

// Internal variant helper exposed under another name so we don't have to
// export `variantsFor` publicly (kept stable for tests).
function variantsForExport(token) { return variantsFor(token); }

// ---------- v3.2: Search Quality Enhancements ----------

// Typo tolerance: calculate Levenshtein distance between two strings
export function levenshteinDistance(a, b) {
  if (!a || !b) return Math.max(a?.length || 0, b?.length || 0);
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// Typo tolerance score: returns 1 for exact match, decreasing for typos
export function typoToleranceScore(query, text) {
  if (!query || !text) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 1;
  
  // Check individual tokens
  const qTokens = tokenise(q);
  const tTokens = tokenise(t);
  let matches = 0;
  
  for (const qt of qTokens) {
    for (const tt of tTokens) {
      if (qt === tt) {
        matches++;
        break;
      } else {
        // Allow one character difference for tokens >= 5 chars
        const dist = levenshteinDistance(qt, tt);
        if (qt.length >= 5 && dist === 1) {
          matches++;
          break;
        }
      }
    }
  }
  
  return qTokens.length > 0 ? matches / qTokens.length : 0;
}

// Query intent detection: identifies what type of query this is
export function detectQueryIntent(query) {
  if (!query) return { type: "general", confidence: 0 };
  
  const q = query.toLowerCase();
  
  // Tutorial intent
  if (/\b(how to|how do|how can|learn|tutorial|guide|beginner|steps|teach)\b/.test(q)) {
    return { type: "tutorial", confidence: 0.9 };
  }
  
  // Comparison intent
  if (/\b(vs|versus|compared|vs\.|difference|compare)\b/.test(q)) {
    return { type: "comparison", confidence: 0.85 };
  }
  
  // Definition intent
  if (/\b(what is|what are|definition|meaning|define|explain)\b/.test(q)) {
    return { type: "definition", confidence: 0.85 };
  }
  
  // Problem-solving intent
  if (/\b(fix|error|issue|problem|solve|debug|troubleshoot|not working|broken)\b/.test(q)) {
    return { type: "problem", confidence: 0.9 };
  }
  
  // Download intent
  if (/\b(download|free|install|get|try)\b/.test(q) && !/\b(price|buy|cost|purchase)\b/.test(q)) {
    return { type: "download", confidence: 0.7 };
  }
  
  // News intent
  if (/\b(news|latest|recent|today|update|announcement)\b/.test(q)) {
    return { type: "news", confidence: 0.8 };
  }
  
  // Video intent
  if (/\b(video|watch|stream|listen|watching)\b/.test(q)) {
    return { type: "video", confidence: 0.8 };
  }
  
  // Local intent
  if (/\b(near me|nearby|local|around me|closest)\b/.test(q)) {
    return { type: "local", confidence: 0.9 };
  }
  
  // Product review intent
  if (/\b(review|best|top|recommend|rating|opinion)\b/.test(q)) {
    return { type: "review", confidence: 0.8 };
  }
  
  return { type: "general", confidence: 0.5 };
}

// Enhanced phrase matching with fuzzy support
export function fuzzyPhraseMatch(query, text, maxEdits = 1) {
  if (!query || !text) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  
  // Exact match
  if (t.includes(q)) return 1;
  
  // Word-by-word fuzzy matching for longer queries
  const qWords = tokenise(q);
  const tWords = tokenise(t);
  
  if (qWords.length === 0) return 0;
  
  let matchedWords = 0;
  for (const qw of qWords) {
    for (const tw of tWords) {
      if (qw === tw) {
        matchedWords++;
        break;
      } else if (qw.length >= 4 && tw.length >= 4) {
        const dist = levenshteinDistance(qw, tw);
        if (dist <= maxEdits) {
          matchedWords++;
          break;
        }
      }
    }
  }
  
  return matchedWords / qWords.length;
}

// Site: operator extraction and matching
export function extractSiteOperator(query) {
  const match = query.match(/\bsite:(\S+)/i);
  if (match) {
    return {
      site: match[1].replace(/^\*\.?/, ""), // Remove leading wildcard
      remainingQuery: query.replace(/\bsite:\S+/i, "").trim(),
    };
  }
  return { site: null, remainingQuery: query };
}

export function matchSiteOperator(resultUrl, site) {
  if (!site) return 1; // No site restriction
  try {
    const host = new URL(resultUrl).hostname.toLowerCase();
    return host.includes(site.toLowerCase()) ? 1.5 : 0; // Bonus for exact site match
  } catch {
    return 0;
  }
}

// ---------- combine ----------

export function combineScore(signals, weights = WEIGHTS) {
  let total = 0;
  for (const k of Object.keys(weights)) {
    const w = weights[k] || 0;
    const v = clamp01(signals[k]);
    total += w * v;
  }
  return clamp01(total);
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
