#!/usr/bin/env node
/**
 * Nook X Fixture Anonymizer
 *
 * Takes a RAW X (Twitter) Bookmarks GraphQL response (captured from the
 * browser's Network tab) and produces a shape-identical but scrubbed copy
 * suitable for committing as tests/fixtures/real-<YYYY-MM>.json.
 *
 * Design goals:
 *  - Never drop a key, change a type, or change array length/nesting.
 *  - Replace every value that could identify a real person deterministically,
 *    so the same input always produces the same output, and so references
 *    between fields (e.g. a tweet's rest_id and its entryId suffix, or a
 *    screen_name and its @mentions in tweet text) stay consistent with each
 *    other in the anonymized output.
 *  - Preserve enough shape (string lengths, date validity, URL scheme/host,
 *    file extensions) that the fixture still looks and behaves like a real
 *    X response.
 *
 * Usage:
 *   node tools/anonymize-x-fixture.js <raw.json> [out.json]
 *
 * If [out.json] is omitted, the output defaults to
 * tests/fixtures/real-<YYYY-MM>.json (current year/month).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

function seedFromString(str) {
  const digest = crypto.createHash("sha256").update(str).digest();
  return digest.readUInt32BE(0);
}

// mulberry32 PRNG — small, fast, deterministic for a given 32-bit seed.
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pure: same seed string -> same [0, 1) value, always.
function pseudoRandom(seedStr) {
  return mulberry32(seedFromString(seedStr))();
}

// ---------------------------------------------------------------------------
// Fakers
// ---------------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

// Deterministically replace ASCII letters/digits in-place, keeping every
// other character (spaces, punctuation, emoji, CJK, newlines, underscores,
// slashes, @, #, etc.) exactly where it was. This guarantees the output has
// the exact same UTF-16 length as the input, so display_text_range / indices
// arrays computed against the original text remain valid against the fake
// text too.
function fakeShapePreserving(original, salt) {
  if (typeof original !== "string" || original.length === 0) return original;
  const chars = Array.from(original);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/[a-zA-Z]/.test(ch)) {
      const r = pseudoRandom(`${salt}|${original}|${i}`);
      const letter = LETTERS[Math.floor(r * 26)];
      out += ch === ch.toUpperCase() ? letter.toUpperCase() : letter;
    } else if (/[0-9]/.test(ch)) {
      const r = pseudoRandom(`${salt}|${original}|${i}|d`);
      out += String(Math.floor(r * 10));
    } else {
      out += ch;
    }
  }
  return out;
}

function fakeNumericId(original) {
  if (typeof original !== "string" || !/^\d+$/.test(original)) return original;
  let out = "";
  for (let i = 0; i < original.length; i++) {
    const r = pseudoRandom(`num|${original}|${i}`);
    let d = Math.floor(r * 10);
    if (i === 0 && original.length > 1 && d === 0) {
      d = 1 + Math.floor(pseudoRandom(`num0|${original}|${i}`) * 9);
    }
    out += d;
  }
  return out;
}

function fakeScreenName(original) {
  // screen_names are alnum + underscore only; fakeShapePreserving already
  // keeps underscores untouched and only scrambles letters/digits.
  return fakeShapePreserving(original, "screen_name");
}

// Faked URL: keeps scheme + host + file extension + query/hash structure
// intact, fakes only the path body characters. Length-preserving.
function fakeUrlDeep(urlStr) {
  const m = urlStr.match(/^(https?:\/\/[^/?#]+)((?:\/[^?#]*)?)(\?[^#]*)?(#.*)?$/);
  if (!m) return fakeShapePreserving(urlStr, "urlfallback");
  const prefix = m[1];
  let pathPart = m[2] || "";
  const queryPart = m[3] || ""; // spec: query keys stay, values may stay as-is
  const hashPart = m[4] || "";

  let ext = "";
  const extMatch = pathPart.match(/(\.[A-Za-z0-9]{1,6})$/);
  if (extMatch) {
    ext = extMatch[1];
    pathPart = pathPart.slice(0, pathPart.length - ext.length);
  }

  const fakedPath = fakeShapePreserving(pathPart, `urlpath|${prefix}`);
  const fakedHash = hashPart ? "#" + fakeShapePreserving(hashPart.slice(1), "urlhash") : "";
  return prefix + fakedPath + ext + queryPart + fakedHash;
}

// Free text: protects @mentions and embedded URLs (e.g. trailing t.co links
// in full_text) so they map consistently with the screen_name/url fakers
// used elsewhere, then shape-scrambles everything else. Length-preserving
// for the non-URL portions (URLs are already length-preserving too).
function fakeFreeText(original) {
  if (typeof original !== "string") return original;
  const tokenRe = /(https?:\/\/\S+)|(@\w+)/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = tokenRe.exec(original)) !== null) {
    result += fakeShapePreserving(original.slice(lastIndex, match.index), "plain");
    if (match[1]) {
      result += fakeUrlDeep(match[1]);
    } else if (match[2]) {
      result += "@" + fakeScreenName(match[2].slice(1));
    }
    lastIndex = tokenRe.lastIndex;
  }
  result += fakeShapePreserving(original.slice(lastIndex), "plain");
  return result;
}

const X_DATE_RE = /^[A-Za-z]{3} [A-Za-z]{3} \d{2} \d{2}:\d{2}:\d{2} \+0000 \d{4}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Fixed, deterministic offset applied to every date so relative ordering is
// preserved but absolute dates no longer match the real capture time.
const DATE_OFFSET_MS = 1000 * 60 * 60 * 24 * 137 + 1000 * 60 * 17;

function toXDateFormat(d) {
  const dow = DAY_NAMES[d.getUTCDay()];
  const mon = MONTH_NAMES[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const yr = d.getUTCFullYear();
  return `${dow} ${mon} ${day} ${hh}:${mm}:${ss} +0000 ${yr}`;
}

function shiftDate(value) {
  if (X_DATE_RE.test(value)) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return toXDateFormat(new Date(d.getTime() + DATE_OFFSET_MS));
  }
  if (ISO_DATE_RE.test(value)) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return new Date(d.getTime() + DATE_OFFSET_MS).toISOString();
  }
  return value;
}

function fakeBase64Id(value) {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const m = decoded.match(/^([A-Za-z]+):(\d+)$/);
    if (m) {
      const fakedDecoded = `${m[1]}:${fakeNumericId(m[2])}`;
      return Buffer.from(fakedDecoded, "utf8").toString("base64");
    }
  } catch (_) {
    // fall through
  }
  return fakeShapePreserving(value, "b64fallback");
}

// ---------------------------------------------------------------------------
// Tree walker
// ---------------------------------------------------------------------------

// Pre-pass: collect every screen_name / display name in the document before
// any transformation happens. This lets the safety net below replace a
// leaked screen_name/name wherever it shows up (e.g. quoted_status_permalink
// "display"/"expanded" fields, which aren't URLs by key name alone) with the
// *same* fake value fakeScreenName()/fakeShapePreserving() would produce for
// that field directly — keeping references consistent regardless of the
// order fields are visited in.
function collectIdentifiers(node, screenNames, names) {
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifiers(item, screenNames, names);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        if (k === "screen_name" && v) screenNames.add(v);
        else if (k === "name" && v) names.add(v);
      } else {
        collectIdentifiers(v, screenNames, names);
      }
    }
  }
}

// Replaces any leftover occurrence of a known original screen_name/name in
// an already-transformed string with the exact fake value the dedicated
// screen_name/name faker would produce, so a field we didn't special-case by
// key (e.g. a permalink's "display"/"expanded" text) can't leak the original
// identifier, and still maps consistently with every other occurrence.
function applySafetyNet(value, screenNamesSorted, namesSorted) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const sn of screenNamesSorted) {
    if (out.includes(sn)) out = out.split(sn).join(fakeScreenName(sn));
  }
  for (const nm of namesSorted) {
    if (out.includes(nm)) out = out.split(nm).join(fakeShapePreserving(nm, "name"));
  }
  return out;
}

function makeTransformer(stats, screenNamesSorted, namesSorted) {
  function transformString(key, value, isCursorObj) {
    return applySafetyNet(computeFake(key, value, isCursorObj), screenNamesSorted, namesSorted);
  }

  function computeFake(key, value, isCursorObj) {
    if (key === "value" && isCursorObj) {
      return fakeShapePreserving(value, "cursor");
    }
    if (key === "entryId") {
      if (typeof value === "string" && value.startsWith("tweet-")) {
        stats.tweetEntries += 1;
      }
      return value.replace(/\d+/g, (run) => fakeNumericId(run));
    }
    if (key === "sortIndex" && /^\d+$/.test(value)) {
      return fakeNumericId(value);
    }
    if ((key === "rest_id" || key === "id_str" || /_id_str$/.test(key) || key === "user_id") && /^\d+$/.test(value)) {
      stats.ids.add(value);
      return fakeNumericId(value);
    }
    if (key === "id") {
      if (/^\d+$/.test(value)) {
        stats.ids.add(value);
        return fakeNumericId(value);
      }
      if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 8) {
        return fakeBase64Id(value);
      }
      return value;
    }
    if (key === "screen_name") {
      stats.screenNames.add(value);
      return fakeScreenName(value);
    }
    if (key === "name") {
      stats.names.add(value);
      return fakeShapePreserving(value, "name");
    }
    if (key === "description") {
      return fakeFreeText(value);
    }
    if (key === "location") {
      return fakeShapePreserving(value, "location");
    }
    if (key === "full_text" || key === "text") {
      return fakeFreeText(value);
    }
    if (key === "ext_alt_text") {
      return fakeFreeText(value);
    }
    if (key === "created_at") {
      return shiftDate(value);
    }
    if (/^https?:\/\//.test(value)) {
      return applySafetyNet(fakeUrlDeep(value), screenNamesSorted, namesSorted);
    }
    // Scheme-less domain+path strings (e.g. quoted_status_permalink.display:
    // "x.com/kenji_w/status/123") — fake them the same way, then fall
    // through to the safety net below regardless.
    if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\//.test(value)) {
      return applySafetyNet(fakeUrlDeep(`https://${value}`).replace(/^https:\/\//, ""), screenNamesSorted, namesSorted);
    }
    if (/^\d{5,}$/.test(value)) {
      // Generic fallback for any other long numeric-string id we didn't
      // special-case by key name (media_key-like fields, etc.).
      stats.ids.add(value);
      return fakeNumericId(value);
    }
    return applySafetyNet(value, screenNamesSorted, namesSorted);
  }

  function walk(node) {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (node && typeof node === "object") {
      const isCursorObj = Object.prototype.hasOwnProperty.call(node, "cursorType") &&
        Object.prototype.hasOwnProperty.call(node, "value");
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string") {
          out[k] = transformString(k, v, isCursorObj);
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return node;
  }

  return walk;
}

// ---------------------------------------------------------------------------
// Structural key-set diff (used by self-test / can be reused by callers)
// ---------------------------------------------------------------------------

function structuralSignature(node, pathStr, out) {
  if (Array.isArray(node)) {
    out.push(`${pathStr}[]=${node.length}`);
    node.forEach((item, i) => structuralSignature(item, `${pathStr}[${i}]`, out));
  } else if (node && typeof node === "object") {
    const keys = Object.keys(node).sort();
    out.push(`${pathStr}{}=${keys.join(",")}`);
    for (const k of keys) structuralSignature(node[k], `${pathStr}.${k}`, out);
  } else {
    out.push(`${pathStr}:${typeof node}`);
  }
  return out;
}

function structurallyIdentical(a, b) {
  const sigA = structuralSignature(a, "$", []);
  const sigB = structuralSignature(b, "$", []);
  if (sigA.length !== sigB.length) return { equal: false, diff: `length ${sigA.length} vs ${sigB.length}` };
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] !== sigB[i]) return { equal: false, diff: `at #${i}: "${sigA[i]}" vs "${sigB[i]}"` };
  }
  return { equal: true, diff: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function anonymize(raw) {
  const stats = { ids: new Set(), screenNames: new Set(), names: new Set(), tweetEntries: 0 };

  const allScreenNames = new Set();
  const allNames = new Set();
  collectIdentifiers(raw, allScreenNames, allNames);
  // Longest-first so a short name that happens to be a substring of a longer
  // one (e.g. "Ada" inside "Ada Lovelace") never gets replaced first and
  // corrupts the longer match.
  const screenNamesSorted = Array.from(allScreenNames).sort((a, b) => b.length - a.length);
  const namesSorted = Array.from(allNames).sort((a, b) => b.length - a.length);

  const walk = makeTransformer(stats, screenNamesSorted, namesSorted);
  const anonymized = walk(raw);
  return { anonymized, stats };
}

function findLeaks(outputObj, stats) {
  const outStr = JSON.stringify(outputObj);
  const leaks = [];
  for (const sn of stats.screenNames) {
    if (sn && sn.length >= 2 && outStr.includes(sn)) leaks.push(`screen_name leak: "${sn}"`);
  }
  for (const nm of stats.names) {
    if (nm && nm.length >= 2 && outStr.includes(nm)) leaks.push(`name leak: "${nm}"`);
  }
  return leaks;
}

function defaultOutPath() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return path.join(__dirname, "..", "tests", "fixtures", `real-${yyyy}-${mm}.json`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const inPath = args[0];
  const outPathArg = args[1];

  if (!inPath) {
    console.error("Usage: node tools/anonymize-x-fixture.js <raw.json> [out.json]");
    process.exit(1);
  }

  const resolvedIn = path.resolve(process.cwd(), inPath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedIn, "utf8"));
  } catch (err) {
    console.error(`Failed to read/parse ${resolvedIn}: ${err.message}`);
    process.exit(1);
  }

  const { anonymized, stats } = anonymize(raw);
  const outPath = outPathArg ? path.resolve(process.cwd(), outPathArg) : defaultOutPath();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(anonymized, null, 2) + "\n");

  const leaks = findLeaks(anonymized, stats);

  console.log("Nook X fixture anonymizer");
  console.log(`  Tweets found:  ${stats.tweetEntries}`);
  console.log(`  Ids mapped:    ${stats.ids.size}`);
  console.log(`  Users mapped:  ${stats.screenNames.size}`);
  console.log(`  Output:        ${outPath}`);

  if (leaks.length > 0) {
    console.warn("WARNING: possible personal data leaks detected in output:");
    for (const l of leaks) console.warn(`  - ${l}`);
    process.exit(1);
  }

  console.log("  Leak scan:     clean");
}

if (require.main === module) {
  main();
}

module.exports = {
  anonymize,
  findLeaks,
  structurallyIdentical,
  fakeShapePreserving,
  fakeNumericId,
  fakeScreenName,
  fakeUrlDeep,
  fakeFreeText,
  shiftDate,
  fakeBase64Id,
  defaultOutPath
};
