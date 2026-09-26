# Self-hosted Nook

Nook runs entirely on your own infrastructure: PostgreSQL stores accounts and
bookmarks, Better Auth issues sessions, the Node API synchronizes records, and
the web app is the Nook product once you're signed in — the same Astryx
dashboard the Chrome extension shows offline. Sign-in and sign-up live only in
the web app; the extension gets its session from it and otherwise stays
usable offline with its existing IndexedDB library.

## URL layout

The web app (`apps/web`) is two separate Vite pages, not one SPA mounted at
the root:

- `/` — a static, JS-free landing placeholder (name, tagline, an "Open the
  app" link). It never loads the app bundle, IndexedDB or auth — see
  `apps/web/index.html`.
- `/app/*` — the actual product, built from `apps/web/app/index.html` and
  routed client-side by `apps/web/src/router.ts`/`src/App.tsx`: `/app`
  redirects to `/app/dashboard` (signed in) or `/app/login` (signed out),
  `/app/login` is the sign-in screen, and `/app/dashboard` is the dashboard.
  Deep links elsewhere under `/app` fall back to `/app/dashboard`; the
  server (`apps/web/nginx.conf` in production, a small Vite dev-server
  middleware locally) rewrites any of them to `/app/index.html` so the
  client router can take over.
- `/api/*` and `/health` are unchanged — the Node API, not part of this split.

The extension's "open web app" links (`apps/extension/src/app/popup/extension-host.ts`'s
`openWebApp`) and the PWA manifest/service worker (scope `/app/`) all target
this `/app` subtree; see the comments in those files for the specifics
(query strings like `?connect=extension` survive every redirect above).

## Local development

1. Copy `.env.example` to `.env`. Set a random `POSTGRES_PASSWORD` and a
   `BETTER_AUTH_SECRET` of at least 32 random characters. `.env` is ignored by Git.
2. Run `docker compose up -d --build`.
3. Open `http://localhost:18481/app` and sign in (or create the first
   account, see `NOOK_ALLOW_SIGNUP` below) — the bare root is just the
   landing page. `/health` checks the API and database.
4. Build the extension against the local API:
   `WXT_API_URL=http://localhost:18481 npm run build -w @nook/extension`.
   Load `apps/extension/.output/chrome-mv3` as an unpacked Chrome extension.
5. With the extension installed and the web app open, sign in and it connects
   itself — no separate cloud sign-in step in the extension. See "Extension
   connection" below.

The extension ID is fixed by its manifest key:
`gldaimigcbcmgadpknjhpnhopfiedgno`. If a different key is used, update
`NOOK_ALLOWED_ORIGINS` to its actual `chrome-extension://` origin — the API
needs it for CORS/trusted origins, and the web app needs it (`VITE_NOOK_EXTENSION_ID`
at build time) to address the right extension when it connects.

The local ports are bound to `127.0.0.1`: web `18481`, API `18482`, and
PostgreSQL `15481`. They can be changed with `NOOK_WEB_HOST_PORT`,
`NOOK_API_HOST_PORT`, and `NOOK_DB_HOST_PORT` in `.env`. Containers continue
to use their private network ports internally.

## Production on nook.beyler.co

Set `BETTER_AUTH_URL=https://nook.beyler.co`, a strong secret and database
password, and `NOOK_ALLOWED_ORIGINS=chrome-extension://gldaimigcbcmgadpknjhpnhopfiedgno`
in `.env`. Set `NOOK_ALLOW_SIGNUP=true` only while creating the initial account;
then set it to `false` and restart the API. Without a configured mail server,
public self-registration would let people claim unverified email addresses.

Point the domain's DNS record at the server. Run
`docker compose -f compose.yaml -f compose.prod.yaml up -d --build` and route
your existing HTTPS reverse proxy to `127.0.0.1:18481`. Nook does not claim
ports 80 or 443 by default. If the host has no reverse proxy and those ports
are free, add `--profile standalone-caddy` to start the bundled Caddy service
for automatic HTTPS certificates. The web, API, and PostgreSQL host ports bind
to localhost only.

Build the release extension with `npm run build -w @nook/extension`; its default
API URL is `https://nook.beyler.co`.

## Backups and recovery

Back up the PostgreSQL volume regularly. For a manual logical backup:

```sh
docker compose exec -T postgres pg_dump -U nook -d nook -Fc > nook-$(date +%F).dump
```

Keep the dump outside the server as well. Restoring to a fresh database should
be rehearsed before production. Existing extension JSON export remains an
additional user-level backup.

After restoring from a backup, rotate the sync epoch:

```sh
docker compose exec -T postgres psql -U nook -d nook -c \
  "UPDATE nook_sync_meta SET value = gen_random_uuid()::text WHERE key = 'epoch';"
```

Every sync response carries the current epoch, and clients remember the last
one they saw. Rotating it makes every client notice on its next sync, reset
its local cursor, and do a full resync that merges against the restored data
— instead of trusting a cursor that was valid before the restore and quietly
missing changes that no longer exist on the server.

## Signing in and the web app

The web app at `<your Nook URL>/app` is the product (see "URL layout" above —
the bare root is just a landing placeholder): sign in (or create the first
account, while `NOOK_ALLOW_SIGNUP` is on) and it opens straight into the same
dashboard the extension shows locally — search, tags, collections, the
lightbox, all of it. It works offline: it's a local-first PWA backed by the
same IndexedDB library and sync engine as the extension, plus a service
worker that caches the app shell. Losing the network mid-session doesn't
interrupt browsing, searching or editing; whatever changed syncs once the
connection is back. The very first load of a signed-in account still needs
one successful network round trip; after that, reopening the app (even from a
home-screen install) works straight from the cached shell and local data,
falling back to the last signed-in account if the session check itself can't
reach the network.

If your session expires (or is revoked from another device via Settings →
Account → Sessions) while the app is online, you're dropped back to the sign
in screen; signing back in as the same account picks the same local library
back up, nothing is lost.

## Extension connection

The extension no longer has its own sign-in flow. Open the web app, sign in,
and — if the extension is installed — it connects itself in the background:
the web app hands it the current session over Chrome's
`externally_connectable` messaging, scoped to this origin only. From then on
the extension syncs on its own schedule, independent of whether the web app
tab is open.

Opening `<your Nook URL>/app?connect=extension` (signed in or not) connects the
extension explicitly and confirms once it's done — useful right after
installing the extension, or from Settings → Account, which links there. If
the extension is already signed in to a different Nook account, connecting
again asks for confirmation before replacing that account's session (its
local library stays; new data uploads under the newly connected account
instead).

When the extension is signed in and online, its own dashboard, options page
and popup "open dashboard" links go to the web app instead of opening a local
page. Offline, or before any account is connected, they still open the
extension's own local dashboard — the one that has always worked without a
network.

## Sync behavior

Sync is automatic and invisible: there's no conflict review to do. The server
stores bookmarks and collections per Better Auth user, every row carries a
server version, and writes use optimistic concurrency. When the same record
changed on two sides — two devices editing the same bookmark before they'd
ever synced with each other, or an edit racing an incoming server change — it
auto-merges field by field (`mergeBookmarks` / `mergeLists` in
`apps/extension/lib/cloud-merge.ts`): newer content wins per field, but never
by silently erasing something only the older side has (tags union, notes keep
whichever side actually has one, media/attachments never lose a video's
playable file to a copy that only has the poster). The same URL saved
independently on two devices before they ever synced is folded into one
bookmark instead of staying two.

You still see status, not silence: a small indicator plus Settings → Sync
shows last-synced time, pending local changes, and anything the server
rejected (invalid or oversized — skipped rather than blocking the rest of the
batch), with a secondary "Sync now" for an on-demand run. The extension syncs
on a periodic alarm; the web app syncs on local writes, when the tab regains
focus or comes back online, and periodically while open. Native Chrome
bookmark IDs are prefixed with a device ID in the cloud, since Chrome IDs are
only unique within one browser profile.

Sync state (cursor, fingerprints, rejected records) is kept per API server, so
pointing a client at a different server, or restoring this one from an old
backup, is a job for **Reset sync** in Settings → Sync: it clears that
bookkeeping and starts a full resync, re-merging against whatever the server
actually has rather than trusting stale local state.

## Settings

Settings (from the user menu in the top nav, on both the web app and the
extension) covers Profile, Account & security (change password, active
sessions with per-session revoke, delete account), Appearance, Sync, AI, Data
(import/export/clear the local library), and About. AI covers the optional
Jev-powered classification of new bookmarks into your collections and tags —
see [ai.md](./ai.md); it is only available when signed in, because a
classification is a server call. Deleting your account
removes it — and everything it owns on the server — immediately; the local
library on that device is cleared too.
