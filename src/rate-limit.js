// Rate-limiting stub — token-bucket implementation keyed by client IP.
//
// This module provides a standalone `checkRateLimit(ip)` function that can
// be imported by any route handler. The main app (src/app.js) has its own
// inline token-bucket for the search endpoint; this module is the shared
// primitive that other routes (submit, scan, maps, etc.) can use without
// duplicating the bucket logic.
//
// Privacy note: IPs are hashed with FNV-1a before being used as map keys.
// The raw IP is never stored. Bucket state is entirely in-process memory
// and is garbage-collected when the bucket refills — no persistent log.

// ---------------------------------------------------------------------------
// Configuration (can be overridden via environment variables)
// ---------------------------------------------------------------------------

const CAPACITY = Number(process.env.RATE_CAPACITY) || 120;   // max tokens per bucket
const REFILL_PER_MS = CAPACITY / 60000;                       // refills at CAPACITY/min
const MAX_BUCKETS = 8192;                                      // evict oldest when full

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Map<string, { tokens: number, updated: number }>} */
const _buckets = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a hash of a string. Fast, cross-runtime, no crypto dependency.
 * Used to avoid storing raw IPs as map keys.
 *
 * @param {string} s
 * @returns {string}  Hex string
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a request from `ip` is within the rate limit.
 * Consumes one token from the bucket. Returns true if the request is allowed,
 * false if the bucket is empty (rate limit exceeded).
 *
 * @param {string} ip     - Client IP address (or any opaque identifier)
 * @param {number} cost   - Number of tokens to consume (default 1)
 * @returns {boolean}
 */
export function checkRateLimit(ip, cost = 1) {
  const key = fnv1a(ip || "anon");
  const now = Date.now();

  let bucket = _buckets.get(key);
  if (!bucket) {
    // Evict the oldest entry when the map is full (Map preserves insertion
    // order, so the first key is the oldest).
    if (_buckets.size >= MAX_BUCKETS) {
      const firstKey = _buckets.keys().next().value;
      if (firstKey !== undefined) _buckets.delete(firstKey);
    }
    bucket = { tokens: CAPACITY, updated: now };
    _buckets.set(key, bucket);
  } else {
    // Refill tokens proportional to elapsed time.
    const elapsed = now - bucket.updated;
    if (elapsed > 0) {
      bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_MS);
      bucket.updated = now;
    }
  }

  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

/**
 * Return the number of tokens remaining for a given IP without consuming any.
 * Useful for returning a `X-RateLimit-Remaining` header.
 *
 * @param {string} ip
 * @returns {number}
 */
export function getRemainingTokens(ip) {
  const key = fnv1a(ip || "anon");
  const bucket = _buckets.get(key);
  if (!bucket) return CAPACITY;
  const elapsed = Date.now() - bucket.updated;
  return Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_MS);
}

/**
 * Reset the bucket for a given IP. Useful in tests or after an admin action.
 *
 * @param {string} ip
 */
export function resetBucket(ip) {
  _buckets.delete(fnv1a(ip || "anon"));
}
