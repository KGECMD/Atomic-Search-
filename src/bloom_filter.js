// bloom_filter.js — Simple probabilistic bloom filter for URL deduplication.
// Uses a Uint8Array bit-array with k independent hash functions derived from
// FNV-1a. Designed to persist across restarts via a binary file in DATA_DIR.
//
// False-positive rate at 1M items with 8 hashes and 10M bits (~1.25 MB):
//   ≈ 0.8% — acceptable for a crawler dedup filter.
//
// Usage:
//   const bf = new BloomFilter(10_000_000, 8);
//   bf.add("https://example.com");
//   bf.has("https://example.com"); // → true (always)
//   bf.has("https://other.com");   // → false (with ~0.8% false-positive rate)

export class BloomFilter {
  /**
   * @param {number} bits  Total number of bits (default: 10_000_000 ≈ 1.25 MB)
   * @param {number} hashes Number of hash functions (default: 8)
   */
  constructor(bits, hashes) {
    this.bits = bits || 10_000_000;
    this.hashes = hashes || 8;
    this.buf = new Uint8Array(Math.ceil(this.bits / 8));
    this.count = 0;
  }

  // FNV-1a 32-bit hash with a seed for independence.
  _hash(str, seed) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  // Returns the k bit positions for a given item.
  _positions(item) {
    const pos = [];
    for (let i = 0; i < this.hashes; i++) {
      pos.push(this._hash(item, i * 0x9e3779b9) % this.bits);
    }
    return pos;
  }

  /** Add an item to the filter. */
  add(item) {
    for (const p of this._positions(item)) {
      this.buf[p >>> 3] |= 1 << (p & 7);
    }
    this.count++;
  }

  /** Test if an item is (probably) in the filter. */
  has(item) {
    for (const p of this._positions(item)) {
      if (!(this.buf[p >>> 3] & (1 << (p & 7)))) return false;
    }
    return true;
  }

  /** Estimated false-positive rate given current count. */
  fpr() {
    const k = this.hashes;
    const m = this.bits;
    const n = this.count;
    return Math.pow(1 - Math.exp(-k * n / m), k);
  }

  /** Serialise to a Buffer (header + bit-array). */
  toBuffer() {
    // 16-byte header: magic(4) + bits(4) + hashes(4) + count(4)
    const header = Buffer.alloc(16);
    header.write("ATBF", 0, "ascii");
    header.writeUInt32LE(this.bits, 4);
    header.writeUInt32LE(this.hashes, 8);
    header.writeUInt32LE(Math.min(this.count, 0xffffffff), 12);
    return Buffer.concat([header, Buffer.from(this.buf)]);
  }

  /** Deserialise from a Buffer. Returns null on format error. */
  static fromBuffer(buf) {
    if (!buf || buf.length < 16) return null;
    if (buf.slice(0, 4).toString("ascii") !== "ATBF") return null;
    const bits   = buf.readUInt32LE(4);
    const hashes = buf.readUInt32LE(8);
    const count  = buf.readUInt32LE(12);
    const expected = Math.ceil(bits / 8);
    if (buf.length < 16 + expected) return null;
    const bf = new BloomFilter(bits, hashes);
    bf.buf = new Uint8Array(buf.buffer, buf.byteOffset + 16, expected);
    bf.count = count;
    return bf;
  }
}

// ── Persistent singleton used by the crawler ────────────────────────────────
// Loaded from DATA_DIR/bloom.bin on startup; saved back periodically.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const BLOOM_FILE = "bloom.bin";
const SAVE_INTERVAL_MS = 5 * 60 * 1000; // save every 5 minutes

let _bf = null;
let _dataDir = null;

function getDataDir() {
  if (_dataDir) return _dataDir;
  _dataDir = path.resolve(
    (typeof process !== "undefined" && process.env?.DATA_DIR) ||
    path.join(process.cwd(), "data")
  );
  return _dataDir;
}

/**
 * Load (or create) the persistent bloom filter.
 * Safe to call multiple times — returns the same instance.
 */
export async function loadBloomFilter() {
  if (_bf) return _bf;
  if (typeof process === "undefined" || !process.versions?.node) {
    _bf = new BloomFilter();
    return _bf;
  }
  const dir = getDataDir();
  const file = path.join(dir, BLOOM_FILE);
  try {
    await fsp.mkdir(dir, { recursive: true });
    if (fs.existsSync(file)) {
      const buf = await fsp.readFile(file);
      const loaded = BloomFilter.fromBuffer(buf);
      if (loaded) {
        _bf = loaded;
        console.log(
          `[bloom] loaded from disk: ${_bf.count.toLocaleString()} items, ` +
          `fpr=${(_bf.fpr() * 100).toFixed(2)}%`
        );
        return _bf;
      }
    }
  } catch (e) {
    console.warn("[bloom] load error:", e?.message || e);
  }
  _bf = new BloomFilter();
  console.log("[bloom] created new filter");
  return _bf;
}

/**
 * Save the bloom filter to disk. Fire-and-forget safe.
 */
export async function saveBloomFilter() {
  if (!_bf) return;
  if (typeof process === "undefined" || !process.versions?.node) return;
  const dir = getDataDir();
  const file = path.join(dir, BLOOM_FILE);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, _bf.toBuffer());
  } catch (e) {
    console.warn("[bloom] save error:", e?.message || e);
  }
}

/**
 * Check if a URL is probably already seen (bloom filter test).
 * Returns false if the filter hasn't been loaded yet (safe default).
 */
export function bloomHas(url) {
  return _bf ? _bf.has(url) : false;
}

/**
 * Mark a URL as seen in the bloom filter.
 */
export function bloomAdd(url) {
  if (_bf) _bf.add(url);
}

// Start the periodic save timer when this module is first imported on Node.
if (typeof process !== "undefined" && process.versions?.node) {
  // Load on first import (async, non-blocking).
  loadBloomFilter().catch(() => {});

  // Periodic save.
  const _saveTimer = setInterval(() => {
    saveBloomFilter().catch(() => {});
  }, SAVE_INTERVAL_MS);
  if (_saveTimer.unref) _saveTimer.unref();

  // Save on graceful shutdown.
  process.once("SIGTERM", () => { saveBloomFilter().catch(() => {}); });
  process.once("SIGINT",  () => { saveBloomFilter().catch(() => {}); });
}
