const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  unwrapTweetResult,
  cleanTweetText,
  parseTweetMedia,
  parseGraphQLTweet,
  extractBottomCursor,
  parseGraphQLBookmarks,
  diagnoseGraphQLResponse
} = require("../apps/extension/x-parser.js");

function loadFixture(filename) {
  const filePath = path.join(__dirname, "fixtures", filename);
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

test("X Parser — Standard Tweet (timeline-v2-standard)", () => {
  const fixture = loadFixture("timeline-v2-standard.json");
  const items = parseGraphQLBookmarks(fixture);

  assert.equal(items.length, 1);
  const item = items[0];

  assert.equal(item.id, "x:2101999689021243625");
  assert.equal(item.source, "x");
  assert.equal(item.url, "https://x.com/_guillecasaus/status/2101999689021243625");
  assert.equal(item.creator.handle, "@_guillecasaus");
  assert.equal(item.creator.name, "Guillermo Casaus");
  assert.match(item.creator.avatar, /pbs\.twimg\.com\/profile_images/);

  // Verifies display_text_range cut off trailing https://t.co/... link
  assert.ok(!item.description.includes("https://t.co/abc123xyz"));
  assert.ok(item.description.startsWith("Cloudflare, yapay zeka"));

  // Media
  assert.equal(item.media.length, 1);
  assert.equal(item.media[0].type, "image");
  assert.equal(item.media[0].alt, "Resim");

  // Cursor extraction
  const cursor = extractBottomCursor(fixture);
  assert.equal(cursor, "DAABCgABGek1Z25-X_8KAAIa...");

  // Diagnostic
  const diag = diagnoseGraphQLResponse(fixture);
  assert.equal(diag.valid, true);
  assert.equal(diag.timelineKey, "bookmark_timeline_v2");
  assert.equal(diag.tweetCount, 1);
  assert.equal(diag.hasBottomCursor, true);
});

test("X Parser — Longform Note Tweet (note-tweet-longform)", () => {
  const fixture = loadFixture("note-tweet-longform.json");
  const items = parseGraphQLBookmarks(fixture);

  assert.equal(items.length, 1);
  const item = items[0];

  assert.equal(item.id, "x:2101983343113884084");
  assert.equal(item.creator.handle, "@AIVersePlay");
  assert.equal(item.creator.name, "AIVersePlay");

  // Should prioritize note_tweet text over truncated legacy full_text
  assert.ok(item.description.includes("Claude code ile beraber calisiyor"));
  assert.ok(!item.description.includes("https://t.co/truncated"));
});

test("X Parser — Quoted Tweet (quote-tweet)", () => {
  const fixture = loadFixture("quote-tweet.json");
  const items = parseGraphQLBookmarks(fixture);

  assert.equal(items.length, 1);
  const item = items[0];

  assert.equal(item.id, "x:2102000000000000001");
  assert.equal(item.creator.handle, "@sconnor");
  assert.equal(item.creator.name, "Sarah Connor");

  // Quoted tweet assertions
  assert.ok(item.quote !== null, "Quote should be parsed and present");
  assert.equal(item.quote.id, "x:2101999999999999999");
  assert.equal(item.quote.creator.handle, "@orig_author");
  assert.equal(item.quote.creator.name, "Original Author");
  assert.ok(item.quote.text.includes("Here is the original announcement"));
  assert.equal(item.quote.media.length, 1);
  assert.equal(item.quote.media[0].type, "image");
});

test("X Parser — Video Tweet (video-tweet)", () => {
  const fixture = loadFixture("video-tweet.json");
  const items = parseGraphQLBookmarks(fixture);

  assert.equal(items.length, 1);
  const item = items[0];

  assert.equal(item.id, "x:2102117617347551447");
  assert.equal(item.media.length, 1);
  assert.equal(item.media[0].type, "video");
  assert.equal(item.media[0].alt, "Demo video");
  assert.match(item.media[0].url, /amplify_video_thumb/);
});

test("X Parser — Legacy User Format & HTML Entity Unescaping (legacy-user-format)", () => {
  const fixture = loadFixture("legacy-user-format.json");
  const items = parseGraphQLBookmarks(fixture);

  assert.equal(items.length, 1);
  const item = items[0];

  assert.equal(item.creator.handle, "@oldschool");
  assert.equal(item.creator.name, "Old School User");
  assert.equal(item.creator.avatar, "https://pbs.twimg.com/profile_images/old.jpg");

  // Unescaping check: &amp; -> &, &lt; -> <, &gt; -> >
  assert.ok(item.description.includes("& HTML entities <b>bold</b>"));
});

test("X Parser — Empty Timeline with Bottom Cursor (empty-cursor-response)", () => {
  const fixture = loadFixture("empty-cursor-response.json");
  const items = parseGraphQLBookmarks(fixture);

  assert.equal(items.length, 0);

  const cursor = extractBottomCursor(fixture);
  assert.equal(cursor, "END_OF_TIMELINE_CURSOR");

  const diag = diagnoseGraphQLResponse(fixture);
  assert.equal(diag.valid, true);
  assert.equal(diag.tweetCount, 0);
  assert.equal(diag.hasBottomCursor, true);
});

test("X Parser — Malformed / Changed Schema / API Errors (malformed-response)", () => {
  const fixture = loadFixture("malformed-response.json");
  const items = parseGraphQLBookmarks(fixture);

  // Must not crash and should return empty array
  assert.equal(items.length, 0);

  const diag = diagnoseGraphQLResponse(fixture);
  assert.equal(diag.valid, false);
  assert.ok(diag.errors.includes("Rate limit exceeded"));
  assert.ok(diag.warnings.some(w => w.includes("some_new_unsupported_key")));
});

test("X Parser — Schema Changed: tweet-like entries present but none parseable (schema-changed-response)", () => {
  const fixture = loadFixture("schema-changed-response.json");
  const items = parseGraphQLBookmarks(fixture);

  // Bug A repro: user.core/user.legacy both missing screen_name, so nothing parses.
  assert.equal(items.length, 0);

  const diag = diagnoseGraphQLResponse(fixture);
  assert.equal(diag.valid, false);
  assert.equal(diag.tweetEntryCount, 2);
  assert.equal(diag.tweetCount, 0);
  assert.ok(diag.warnings.some(w => w.includes("Schema may have changed")));
});

test("X Parser — Cursor-only page is a normal end-of-list, not a schema warning (empty-cursor-response)", () => {
  const fixture = loadFixture("empty-cursor-response.json");

  const diag = diagnoseGraphQLResponse(fixture);
  assert.equal(diag.valid, true);
  assert.equal(diag.tweetEntryCount, 0);
  assert.equal(diag.tweetCount, 0);
  assert.ok(!diag.warnings.some(w => w.includes("Schema may have changed")));
});

test("X Parser — Partial parse: one good tweet, one unparseable (partial-parse-response)", () => {
  const fixture = loadFixture("partial-parse-response.json");
  const items = parseGraphQLBookmarks(fixture);

  assert.equal(items.length, 1);

  const diag = diagnoseGraphQLResponse(fixture);
  assert.equal(diag.valid, true);
  assert.equal(diag.tweetEntryCount, 2);
  assert.equal(diag.tweetCount, 1);
  assert.ok(diag.warnings.some(w => w.includes("Only 1 of 2 tweet-like entries could be parsed")));
});

test("X Parser — Edge Cases & Fault Tolerance", () => {
  assert.deepEqual(parseGraphQLBookmarks(null), []);
  assert.deepEqual(parseGraphQLBookmarks(undefined), []);
  assert.deepEqual(parseGraphQLBookmarks({}), []);
  assert.deepEqual(parseGraphQLBookmarks("not an object"), []);

  assert.equal(extractBottomCursor(null), null);
  assert.equal(extractBottomCursor({}), null);

  assert.equal(unwrapTweetResult(null), null);
  assert.equal(parseGraphQLTweet(null), null);

  const diagNull = diagnoseGraphQLResponse(null);
  assert.equal(diagNull.valid, false);
  assert.ok(diagNull.errors.length > 0);
});

test("X Parser — Synthetic current-format sample (synthetic-current-format)", () => {
  const fixture = loadFixture("synthetic-current-format.json");
  const items = parseGraphQLBookmarks(fixture);

  // 1. Sıfırdan fazla tweet okunuyor
  assert.ok(items.length > 0, "Sıfırdan fazla tweet okunabilmeli");
  assert.equal(items.length, 5, "5 adet tweet başarıyla parse edilmeli");

  // 2. Her birinin kullanıcı adı var
  for (const item of items) {
    assert.ok(item.id && item.id.startsWith("x:"), `Her tweet'in geçerli bir id'si olmalı: ${item.id}`);
    assert.ok(item.creator, `Tweet (${item.id}) creator nesnesine sahip olmalı`);
    assert.ok(
      typeof item.creator.handle === "string" && item.creator.handle.length > 1,
      `Tweet (${item.id}) kullanıcı adına (handle) sahip olmalı`
    );
    assert.ok(
      item.creator.handle.startsWith("@"),
      `Kullanıcı adı '@' ile başlamalı: ${item.creator.handle}`
    );
    assert.ok(
      typeof item.creator.name === "string" && item.creator.name.length > 0,
      `Tweet (${item.id}) görüntülenen isme (name) sahip olmalı`
    );
    assert.ok(item.url, `Tweet (${item.id}) URL'e sahip olmalı`);
    assert.ok(typeof item.description === "string" && item.description.length > 0, `Tweet açıklaması olmalı`);
  }

  // 3. Sayfalama (Pagination cursor) kontrolü
  const cursor = extractBottomCursor(fixture);
  assert.ok(cursor, "Sayfalama için bottom cursor bulunabilmeli");
  assert.equal(cursor, "DAABCgABGek1Z25-real202609cursor_token_xyz");

  // 4. Teşhis (Diagnostic) kontrolü
  const diag = diagnoseGraphQLResponse(fixture);
  assert.equal(diag.valid, true);
  assert.equal(diag.timelineKey, "bookmark_timeline_v2");
  assert.equal(diag.tweetCount, 5);
  assert.equal(diag.hasBottomCursor, true);
  assert.equal(diag.errors.length, 0);
  assert.equal(diag.warnings.length, 0);
});

// Picks up any anonymized real-world snapshot(s) dropped into
// tests/fixtures/real-*.json (produced via `npm run fixture:anonymize`,
// see tools/anonymize-x-fixture.js). These are not committed by default —
// each contributor generates their own from their browser — so this test
// skips cleanly when none exist rather than failing CI.
test("X Parser — Real-world snapshots (tests/fixtures/real-*.json)", async (t) => {
  const fixturesDir = path.join(__dirname, "fixtures");
  const realFixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((f) => /^real-.*\.json$/.test(f));

  if (realFixtureFiles.length === 0) {
    t.skip("No tests/fixtures/real-*.json snapshots found; run `npm run fixture:anonymize` to generate one.");
    return;
  }

  for (const filename of realFixtureFiles) {
    await t.test(filename, () => {
      const fixture = loadFixture(filename);
      const items = parseGraphQLBookmarks(fixture);

      assert.ok(items.length > 0, `${filename}: expected at least one parsed item`);

      for (const item of items) {
        assert.ok(
          typeof item.creator.handle === "string" && item.creator.handle.startsWith("@") && item.creator.handle.length > 1,
          `${filename}: item (${item.id}) should have a valid handle`
        );
        assert.ok(
          typeof item.creator.name === "string" && item.creator.name.length > 0,
          `${filename}: item (${item.id}) should have a non-empty creator name`
        );
        assert.match(
          item.url,
          /^https:\/\/x\.com\/[^/]+\/status\/\d+$/,
          `${filename}: item (${item.id}) should have a well-formed status URL`
        );
      }

      const diag = diagnoseGraphQLResponse(fixture);
      assert.equal(diag.valid, true, `${filename}: diagnostic should report valid`);
      assert.deepEqual(diag.warnings, [], `${filename}: diagnostic should report no warnings`);
      assert.equal(
        diag.tweetCount,
        diag.tweetEntryCount,
        `${filename}: every tweet-like entry should have parsed successfully`
      );
    });
  }
});

