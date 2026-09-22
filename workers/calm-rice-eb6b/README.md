# calm-rice-eb6b

Shared Cloudflare Worker at `https://calm-rice-eb6b.morgan-2bf.workers.dev`.

Until 2026-08-04 this worker had **no source in version control** — it was
deployed only, and had to be recovered from the Cloudflare API to be changed
safely. Keep this directory in sync with what is deployed.

## What depends on it

Breaking any of these breaks a live app:

| Route | Used by |
|---|---|
| `GET /sync?key=expenses` | Expenses app, dashboard Overview "Money" widget |
| `POST /sync?key=expenses` | Expenses app (also mirrors to a Google Sheet) |
| `GET/POST /sync?key=dashboard` | Dashboard state |
| `GET/POST /sync?key=engagement_*` | Engagement Finder |
| `POST /` (root) | Stats app AI calls |

## Auth (since 2026-09-22)

Every `/sync` call and the Anthropic proxy need `Authorization: Bearer <token>`, where the token is
either a dashboard login token (from `messick-marketing-ai-proxy /login`, verified with the shared
`DASH_TOKEN_SECRET` secret, which must match in both workers) or `SYNC_ADMIN_KEY` (machine use; copy in
`~/.secrets/mm-sync-admin-key.txt`). The pages sign in through `/assets/mm-auth.js`.

The one open door is `POST /sync?key=engagement_inbox&append=1`, which Chrome harvest jobs post to
from arbitrary pages. It can only add posts. `AUTH_MODE` var: `enforce` rejects, `log` lets calls
through and logs them (use for rollouts). A bare `curl` of the verify commands below now returns 401;
add the admin key header.

## Routes

**`GET /sync?key=<name>`** — returns the stored JSON, or `{}` if the key is unset.
Arbitrary keys are allowed.

**`POST /sync?key=<name>`** — **replaces** the whole stored value.
When `key=expenses`, also mirrors the body to `SHEET_WEBHOOK_URL` (non-blocking;
a Sheet failure never fails the KV write).

**`POST /sync?key=<name>&append=1`** — merges instead of replacing. Added
2026-08-04 for the engagement inbox, where several harvest jobs report in
independently and a plain POST meant the second silently destroyed the first.

- Body must be a JSON **object** containing a `posts` array.
- `posts` accumulates; posts already present are dropped, matched on a
  normalised URL (scheme, `www.`, query string and trailing slash ignored), so
  re-sending the same batch is harmless.
- All other top-level fields merge with the newest writer winning.
- Returns `{ok, appended, duplicates, total, dropped}`.
- Caps stored posts at 2000, keeping the most recent.

**`POST /`** (any other path) — Anthropic proxy. Body is `{payload: <Messages API request>}`
and the response is the raw Anthropic response, so read `content[0].text`.
Note this is a **different contract** from the `messick-marketing-ai-proxy`
worker's `/claude` route, which takes `{prompt}` and returns `{text}`.

## Bindings

`wrangler.toml` must keep declaring these. Wrangler replaces bindings on deploy,
so dropping one from the config unbinds it in production:

- `MM_SYNC` — KV namespace `aa76673f04354e25b5d56e4ace371c74`
- `SHEET_WEBHOOK_URL` — plain text var
- `ANTHROPIC_KEY` — **secret**, preserved automatically across deploys. Never
  put it in `wrangler.toml`.

## Deploying

```bash
npx wrangler deploy
```

Run it from this directory. Wrangler fails oddly if run from `C:\Windows\System32`
or `C:\Users\morga`.

After deploying, allow ~60s before trusting a test. During rollout some requests
still hit the previous version, which looks exactly like a logic bug — a fresh
`&append=1` call returning a bare `{"ok":true}` means it reached old code, not
that append is broken. Re-test after it settles.

Verify these four before walking away:

```bash
U=https://calm-rice-eb6b.morgan-2bf.workers.dev
curl -s "$U/sync?key=expenses" -o /dev/null -w '%{http_code} %{size_download}b\n'
curl -s "$U/" 
curl -s -X POST "$U/" -H 'Content-Type: application/json' \
  -d '{"payload":{"model":"claude-haiku-4-5-20251001","max_tokens":8,"messages":[{"role":"user","content":"say OK"}]}}'
curl -s -X POST "$U/sync?key=probe&append=1" -H 'Content-Type: application/json' -d '{"posts":[{"postUrl":"a"}]}'
```
