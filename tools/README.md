# tools/

## anonymize-x-fixture.js

Turns a raw X (Twitter) Bookmarks GraphQL response into a scrubbed fixture
that still has the exact shape (all keys, wrappers, nesting) X actually
sends, so the parser's tests catch real shape drift instead of just testing
against the parser's own assumptions.

### Capturing a raw response

1. Open `x.com/i/bookmarks` in a logged-in browser tab.
2. Open DevTools → Network, and filter for `Bookmarks`.
3. Scroll the bookmarks page so a `Bookmarks` GraphQL request fires.
4. Click the request → Response tab → copy the full JSON body.
5. Save it **outside the repo**, e.g. `~/Desktop/raw.json`.

### Anonymizing it

```sh
npm run fixture:anonymize -- ~/Desktop/raw.json
```

This writes `tests/fixtures/real-<YYYY-MM>.json` by default (pass a second
argument to choose a different output path). It prints a summary of what
was mapped and does a final scan of the output for any leftover trace of
the original screen names / display names, exiting non-zero if it finds
one.

Review the generated file before committing it — spot check that it still
reads like a real API response but no longer contains anything identifying.

### Important

**Never commit the raw response file.** It contains real usernames, real
tweet text, and other personal data pulled straight from your bookmarks.
`raw*.json` at the repo root is already covered by `.gitignore`, but the
safest approach is to keep the raw capture outside the repo entirely and
delete it once you've generated the anonymized fixture.
