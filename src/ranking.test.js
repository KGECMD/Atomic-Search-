// Lightweight unit tests for the ranking module. Runs under `node --test`
// or as a plain script (fails non-zero on mismatch). No framework required.

import test from "node:test";
import assert from "node:assert/strict";
import {
  WEIGHTS,
  stripTitleBrand,
  tokenise,
  buildQueryContext,
  bm25Score,
  titleMatchScore,
  authorityScore,
  structureScore,
  agreementScore,
  rrfNormalised,
  combineScore,
  levenshteinDistance,
  typoToleranceScore,
  detectQueryIntent,
  fuzzyPhraseMatch,
  extractSiteOperator,
  matchSiteOperator,
} from "./ranking.js";

test("WEIGHTS sum to exactly 1.0", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum = ${sum}`);
});

test("stripTitleBrand removes common suffixes", () => {
  assert.equal(stripTitleBrand("Linux kernel - Wikipedia"), "Linux kernel");
  assert.equal(stripTitleBrand("Array | MDN Web Docs"), "Array");
  assert.equal(stripTitleBrand("React: The Library"), "React: The Library"); // not a brand suffix
  assert.equal(stripTitleBrand("Foo — Docs"), "Foo");
});

test("tokenise drops punctuation and lowercases", () => {
  assert.deepEqual(tokenise("React.js — hooks!"), ["react", "js", "hooks"]);
});

test("buildQueryContext drops stopwords", () => {
  const ctx = buildQueryContext("how to use a git rebase");
  assert.deepEqual(ctx.tokens, ["use", "git", "rebase"]);
});

test("titleMatchScore: exact match beats prefix beats coverage", () => {
  const ctx = buildQueryContext("linux kernel");
  const exact = titleMatchScore({ title: "Linux kernel - Wikipedia" }, ctx);
  const prefix = titleMatchScore({ title: "Linux kernel version history" }, ctx);
  const cover = titleMatchScore({ title: "Linux distro running a kernel" }, ctx);
  const none = titleMatchScore({ title: "How Windows works" }, ctx);
  assert.ok(exact > prefix, `exact(${exact}) should beat prefix(${prefix})`);
  assert.ok(prefix > cover, `prefix(${prefix}) should beat coverage(${cover})`);
  assert.ok(cover > none, `coverage(${cover}) should beat no match(${none})`);
  assert.equal(exact, 1.0);
});

test("bm25Score rewards on-topic snippet", () => {
  const ctx = buildQueryContext("react hooks");
  const good = bm25Score(
    { title: "React Hooks", snippet: "React hooks let you use state" },
    ctx
  );
  const bad = bm25Score(
    { title: "Something else", snippet: "Unrelated content" },
    ctx
  );
  assert.ok(good > bad + 0.3, `good(${good}) should strongly beat bad(${bad})`);
  assert.ok(good <= 1.0 && bad >= 0.0);
});

test("authorityScore maps tiers correctly", () => {
  assert.equal(authorityScore(3), 1.0);
  assert.equal(authorityScore(2), 0.66);
  assert.equal(authorityScore(1), 0.33);
  assert.equal(authorityScore(0), 0);
});

test("structureScore: matching-host homepage beats deep path", () => {
  const ctx = buildQueryContext("linux kernel");
  const home = structureScore("https://kernel.org/", ctx);
  const deep = structureScore("https://kernel.org/doc/html/latest/x/y/z.html", ctx);
  const unrelatedHome = structureScore("https://example.com/", ctx);
  assert.equal(home, 1.0);
  assert.ok(deep < home);
  assert.ok(unrelatedHome < home);
});

test("agreementScore is log-scaled and capped", () => {
  assert.equal(agreementScore(1), 0);
  assert.ok(agreementScore(2) > 0);
  assert.ok(agreementScore(4) >= 0.99);
  assert.ok(agreementScore(8) <= 1);
});

test("rrfNormalised divides by observed max", () => {
  assert.equal(rrfNormalised(0.1, 0.1), 1);
  assert.equal(rrfNormalised(0.05, 0.1), 0.5);
  assert.equal(rrfNormalised(0, 0.1), 0);
});

test("combineScore respects weights", () => {
  const full = combineScore({
    bm25: 1, titleMatch: 1, agreement: 1, authority: 1,
    rrf: 1, structure: 1, proximity: 1,
  });
  assert.ok(Math.abs(full - 1) < 1e-9, `all-1 should give 1, got ${full}`);
  const empty = combineScore({
    bm25: 0, titleMatch: 0, agreement: 0, authority: 0,
    rrf: 0, structure: 0, proximity: 0,
  });
  assert.equal(empty, 0);
});

// Integration sanity check: the canonical Wikipedia page for a query should
// always outrank a tangential Wikipedia page and a random blog.
test("integration: 'linux kernel' → Linux kernel page wins", () => {
  const ctx = buildQueryContext("linux kernel");

  function score(item, tier, rrfRaw, rrfMax, n) {
    return combineScore({
      bm25: bm25Score(item, ctx),
      titleMatch: titleMatchScore(item, ctx),
      agreement: agreementScore(n),
      authority: authorityScore(tier),
      rrf: rrfNormalised(rrfRaw, rrfMax),
      structure: structureScore(item.url, ctx),
    });
  }

  const canonical = score(
    {
      url: "https://en.wikipedia.org/wiki/Linux_kernel",
      title: "Linux kernel - Wikipedia",
      snippet: "The Linux kernel is a free and open-source monolithic Unix-like kernel.",
    },
    3, 0.05, 0.05, 3
  );
  const tangent = score(
    {
      url: "https://en.wikipedia.org/wiki/Linux_kernel_version_history",
      title: "Linux kernel version history - Wikipedia",
      snippet: "History of Linux kernel versions since 1991.",
    },
    3, 0.04, 0.05, 2
  );
  const homepage = score(
    {
      url: "https://kernel.org/",
      title: "The Linux Kernel Archives",
      snippet: "About Linux Kernel. Protocol. Pub. License.",
    },
    3, 0.03, 0.05, 2
  );
  const blog = score(
    {
      url: "https://random-blog.example.com/why-i-love-linux",
      title: "Why I love Linux and you should too",
      snippet: "A personal blog post about Linux.",
    },
    0, 0.01, 0.05, 1
  );

  assert.ok(canonical > tangent, `canonical(${canonical}) should beat tangent(${tangent})`);
  assert.ok(canonical > blog, `canonical(${canonical}) should beat blog(${blog})`);
  assert.ok(homepage > blog, `homepage(${homepage}) should beat blog(${blog})`);
});

// ---------- v3.2: New Search Quality Tests ----------

test("levenshteinDistance: basic string distance", () => {
  assert.equal(levenshteinDistance("cat", "cat"), 0); // identical
  assert.equal(levenshteinDistance("cat", "bat"), 1); // one substitution
  assert.equal(levenshteinDistance("cat", "cats"), 1); // one insertion
  assert.equal(levenshteinDistance("cat", "at"), 1); // one deletion
  assert.equal(levenshteinDistance("kitten", "sitting"), 3); // classic example
});

test("typoToleranceScore: exact match returns 1", () => {
  assert.equal(typoToleranceScore("javascript", "Learn javascript"), 1);
});

test("typoToleranceScore: partial token match", () => {
  const score = typoToleranceScore("react hooks", "using react hook api");
  assert.ok(score > 0.5, `score ${score} should be > 0.5`);
});

test("typoToleranceScore: handles empty inputs", () => {
  assert.equal(typoToleranceScore("", "test"), 0);
  assert.equal(typoToleranceScore("test", ""), 0);
  assert.equal(typoToleranceScore("", ""), 0);
});

test("detectQueryIntent: tutorial queries", () => {
  const intent = detectQueryIntent("how to install nodejs");
  assert.equal(intent.type, "tutorial");
  assert.ok(intent.confidence >= 0.8);
});

test("detectQueryIntent: comparison queries", () => {
  const intent = detectQueryIntent("react vs vue vs angular");
  assert.equal(intent.type, "comparison");
  assert.ok(intent.confidence >= 0.8);
});

test("detectQueryIntent: definition queries", () => {
  const intent = detectQueryIntent("what is a closure in javascript");
  assert.equal(intent.type, "definition");
  assert.ok(intent.confidence >= 0.8);
});

test("detectQueryIntent: debug queries", () => {
  const intent = detectQueryIntent("fix npm error not found");
  assert.equal(intent.type, "problem");
  assert.ok(intent.confidence >= 0.8);
});

test("detectQueryIntent: general queries default", () => {
  const intent = detectQueryIntent("random web search");
  assert.equal(intent.type, "general");
  assert.ok(intent.confidence >= 0.4);
});

test("fuzzyPhraseMatch: exact match returns 1", () => {
  assert.equal(fuzzyPhraseMatch("linux kernel", "about the linux kernel"), 1);
});

test("fuzzyPhraseMatch: partial match returns partial score", () => {
  const score = fuzzyPhraseMatch("how to use python", "tutorial about python basics");
  assert.ok(score > 0, `score ${score} should be > 0`);
  assert.ok(score < 1, `score ${score} should be < 1`);
});

test("fuzzyPhraseMatch: empty inputs return 0", () => {
  assert.equal(fuzzyPhraseMatch("", "test"), 0);
  assert.equal(fuzzyPhraseMatch("test", ""), 0);
});

test("extractSiteOperator: extracts site from query", () => {
  const result = extractSiteOperator("react hooks site:github.com");
  assert.equal(result.site, "github.com");
  assert.equal(result.remainingQuery, "react hooks");
});

test("extractSiteOperator: no site operator", () => {
  const result = extractSiteOperator("regular search query");
  assert.equal(result.site, null);
  assert.equal(result.remainingQuery, "regular search query");
});

test("extractSiteOperator: wildcard subdomain", () => {
  const result = extractSiteOperator("docs site:*.google.com");
  assert.equal(result.site, "google.com");
});

test("matchSiteOperator: exact match returns bonus", () => {
  assert.ok(matchSiteOperator("https://github.com/user/repo", "github.com") > 1);
});

test("matchSiteOperator: no match returns 0", () => {
  assert.equal(matchSiteOperator("https://example.com", "github.com"), 0);
});

test("matchSiteOperator: no site restriction returns 1", () => {
  assert.equal(matchSiteOperator("https://any.com", null), 1);
});
