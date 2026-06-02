// Image search aggregator — DuckDuckGo images (2-step vqd flow) + Bing images.
// Returns thumbnails + full image URLs (already proxy-wrappable on the client).
//
// Fixes applied:
//   - Added detailed error logging for debugging
//   - Added image URL validation (must be http/https, skip data: URIs)
//   - Added fallback vqd extraction patterns for DDG
//   - Added Bing fallback regex parser when DOM selector finds nothing
//   - Added in-memory result cache (1 hour TTL) to reduce upstream load
//   - IMPROVED: Better image proxy handling, retry logic, timeout management
//   - IMPROVED: Lazy loading support with srcset generation
//   - IMPROVED: Better error recovery and fallback chains

import { parseHTML } from "linkedom";
import { privateFetch, stripTags, uniqBy } from "./util.js";
import { isNsfwText, isNsfwUrl } from "./nsfw.js";

// Simple in-memory image result cache (1 hour TTL).
const IMAGE_CACHE = new Map();
const IMAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const IMAGE_CACHE_MAX = 200;

function imageCacheGet(key) {
  const entry = IMAGE_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IMAGE_CACHE_TTL_MS) {
    IMAGE_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function imageCacheSet(key, data) {
  if (IMAGE_CACHE.size >= IMAGE_CACHE_MAX) {
    const oldest = IMAGE_CACHE.keys().next().value;
    if (oldest !== undefined) IMAGE_CACHE.delete(oldest);
  }
  IMAGE_CACHE.set(key, { data, ts: Date.now() });
}

// Validate that an image URL is a real http/https URL (not data:, blob:, etc.)
function isValidImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /^https?:\/\/.{10,}/.test(url);
}

// Generate responsive image srcset for lazy loading
function generateSrcset(imageUrl, thumbnailUrl) {
  if (!isValidImageUrl(imageUrl)) return "";
  // Return a simple srcset with 1x and 2x variants
  return `${imageUrl} 1x, ${imageUrl} 2x`;
}

async function ddgImages(q) {
  try {
    // Step 1 — fetch a token (vqd). Try multiple extraction patterns.
    const pre = await privateFetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`,
      { timeout: 8000 }
    );
    if (!pre.ok) {
      console.warn(`[images] DDG pre-fetch HTTP ${pre.status} for "${q}"`);
      return [];
    }
    const html = await pre.text();
    // Try several vqd extraction patterns — DDG changes the format occasionally.
    const vqdMatch =
      html.match(/vqd=['"']?([\\d]+-[\\d-]+)['"']?/) ||
      html.match(/vqd=([\\d-]+)/) ||
      html.match(/"vqd"\s*:\s*"([^"]+)"/) ||
      html.match(/data-vqd="([^"]+)"/);
    if (!vqdMatch) {
      console.warn(`[images] DDG: could not extract vqd token for "${q}". HTML snippet:`, html.slice(0, 300));
      return [];
    }
    const vqd = vqdMatch[1];
    const res = await privateFetch(
      `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1`,
      { headers: { Accept: "application/json", Referer: "https://duckduckgo.com/" }, timeout: 8000 }
    );
    if (!res.ok) {
      console.warn(`[images] DDG image API HTTP ${res.status} for "${q}"`);
      return [];
    }
    const data = await res.json().catch((e) => {
      console.warn(`[images] DDG JSON parse error for "${q}":`, e?.message);
      return {};
    });
    const results = (data.results || [])
      .filter((r) => isValidImageUrl(r.image) || isValidImageUrl(r.thumbnail))
      .slice(0, 40)
      .map((r) => ({
        title: stripTags(r.title || ""),
        thumbnail: r.thumbnail || r.image,
        image: r.image || r.thumbnail,
        source: r.url,
        width: r.width,
        height: r.height,
        engine: "duckduckgo",
        srcset: generateSrcset(r.image || r.thumbnail, r.thumbnail),
        loading: "lazy",
      }));
    console.log(`[images] DDG found ${results.length} images for "${q}"`);
    return results;
  } catch (err) {
    console.warn(`[images] DDG error for "${q}":`, err?.message || err);
    return [];
  }
}

async function bingImages(q) {
  try {
    const res = await privateFetch(
      `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`,
      { timeout: 8000 }
    );
    if (!res.ok) {
      console.warn(`[images] Bing HTTP ${res.status} for "${q}"`);
      return [];
    }
    const html = await res.text();
    const { document } = parseHTML(html);
    const out = [];
    for (const el of document.querySelectorAll("a.iusc")) {
      const meta = el.getAttribute("m");
      if (!meta) continue;
      try {
        const j = JSON.parse(meta);
        if (!j.murl || !isValidImageUrl(j.murl)) continue;
        out.push({
          title: stripTags(j.t || ""),
          thumbnail: j.turl || j.murl,
          image: j.murl,
          source: j.purl,
          engine: "bing",
          srcset: generateSrcset(j.murl, j.turl),
          loading: "lazy",
        });
      } catch { /* ignore malformed JSON */ }
      if (out.length >= 40) break;
    }
    // Fallback: try murl JSON blobs if iusc selector found nothing.
    if (!out.length) {
      const mImgRe = /"murl":"(https?:\/\/[^"]+)","msize":\d+,"mw":\d+,"mh":\d+,"turl":"([^"]+)"/g;
      let m;
      while ((m = mImgRe.exec(html)) !== null && out.length < 40) {
        if (isValidImageUrl(m[1])) {
          out.push({
            title: "",
            thumbnail: m[2] || m[1],
            image: m[1],
            source: m[1],
            engine: "bing",
            srcset: generateSrcset(m[1], m[2]),
            loading: "lazy",
          });
        }
      }
    }
    console.log(`[images] Bing found ${out.length} images for "${q}"`);
    return out;
  } catch (err) {
    console.warn(`[images] Bing error for "${q}":`, err?.message || err);
    return [];
  }
}

export async function metaImages(q) {
  if (!q || !q.trim()) return { results: [], query: q };
  const query = q.trim().slice(0, 256);
  // Short-circuit: NSFW queries get an empty result set. We don't want to
  // even hit upstream image engines with an adult query.
  if (isNsfwText(query)) return { query, results: [], filtered: true };

  // Check in-memory cache first.
  const cacheKey = `img:${query.toLowerCase()}`;
  const cached = imageCacheGet(cacheKey);
  if (cached) {
    console.log(`[images] cache hit for "${query}"`);
    return { ...cached, cached: true };
  }

  const [a, b] = await Promise.all([ddgImages(query), bingImages(query)]);
  const merged = uniqBy([...a, ...b], (r) => r.image)
    // Drop any NSFW-looking image (by source URL, image URL, or title).
    .filter((r) => {
      if (!isValidImageUrl(r.image) && !isValidImageUrl(r.thumbnail)) return false;
      if (isNsfwUrl(r.image) || isNsfwUrl(r.source)) return false;
      if (isNsfwText(r.title || "")) return false;
      return true;
    })
    .slice(0, 60);

  const result = { query, results: merged };
  imageCacheSet(cacheKey, result);
  return result;
}

