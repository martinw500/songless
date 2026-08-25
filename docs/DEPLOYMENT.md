# Vercel deployment

## Why Vercel instead of GitHub Pages

Both services can host this static Vite application. Vercel is the default because it handles a Vite project at the domain root, creates preview deployments automatically, and also offers optional access protection. GitHub Pages would work, but it requires repository-path configuration and a separate Actions workflow without improving this project.

A private Git repository does **not** make either deployed website private by itself. This project does not require privacy: a public URL is convenient for sharing with your girlfriend and friends.

## What is already configured

- `vercel.json` selects Vite, runs the production build, and serves `dist`.
- Every response gets `X-Robots-Tag: noindex, nofollow, noarchive`.
- `public/robots.txt` asks crawlers not to index any route.
- `.vercelignore` excludes development-only files. R2-backed catalogues contain URLs and metadata, not audio files.
- `api/feedback.ts` relays the in-game feedback form to Discord.

Crawler directives reduce accidental search-engine discovery; they are not access control. Public R2 media URLs can be requested directly by anyone who obtains them.

## Public production deployment

The promoted catalogue already contains R2 public URLs, so Vercel needs no R2 credential. Never put `R2_SECRET_ACCESS_KEY` or `R2_ACCESS_KEY_ID` into a `VITE_` variable; they remain only in ignored local `.env.local` for uploads.

If the public hostname changes after objects are uploaded, update `R2_PUBLIC_BASE_URL` and run `npm run sync:r2`. This verifies that every expected object exists and rewrites catalogue URLs without consuming upload operations.

## Feedback relay

The feedback form posts to `/api/feedback`, which forwards the message to Discord and attaches the song the player was on. Set `DISCORD_WEBHOOK_URL` in **Settings → Environment Variables** and in ignored `.env.local`; without it the endpoint answers 503 and the form reports that feedback is not configured, rather than silently discarding the message.

The variable must not carry a `VITE_` prefix. A `VITE_` variable is inlined into the client bundle, so publishing the webhook there would let any visitor read it and post to, or delete, the channel. The relay runs server-side for that reason, and it strips mentions, caps message length, and rate-limits a single address to five messages a minute. A server-only fallback still reads `VITE_DISCORD_WEBHOOK_URL` if the documented name is missing, so an already-deployed project env keeps working, but new setup should use `DISCORD_WEBHOOK_URL`.

`npm run dev` serves the relay through a Vite middleware so the in-game form works locally. `node --experimental-strip-types --test tests/feedback.test.mjs` drives the handler against a stand-in webhook. Production still needs the same variable on Vercel.

From the project directory:

```powershell
npx vercel@latest --prod
```

Accept Vercel's Vite defaults when prompted. Vercel will print a stable production URL that can be sent to anyone.

This URL is public. Players need no service account for R2-hosted playback.

The included `robots.txt` and response header ask search engines not to list it. This makes the deployment *unlisted*, not private. Remove those directives later if you want the game to be discoverable through search.

## Updating the deployed game

After changing the catalogue, update production from the same local directory:

```powershell
npx vercel@latest --prod
```

The stable production URL will move to the new deployment. R2 serves the audio, so no audio is committed or uploaded to Vercel.

## Optional private mode

If you later decide to restrict access:

1. Open **Settings → Deployment Protection** in Vercel.
2. Enable Vercel Authentication for all deployments.
3. Invite specific viewers or create a shareable bypass link.
4. Verify the ordinary URL in an incognito browser.

Protection is an option, not a requirement for the game.

## Git integration

R2-backed deployment is compatible with automatic Git builds because the tracked catalogue contains only small JSON metadata and public object URLs. R2 API credentials are not needed at build or runtime.

## Audio and storage

Cloudflare R2 delivers a compact clue file and a complete result track directly to the browser. Vercel hosts no real-song audio, so expanding the library barely changes deployment size and does not require a database.

The uploader's 8.5 GB default ceiling is intentionally below the 10 GB allowance. Run `npm run check:r2` to validate credentials and read the bucket's current usage without needing prepared media. The uploader totals every object in the target bucket and performs a no-write projection before the batch; run the dedicated `npm run upload:r2:dry-run` command before every material upload. The script cannot see unrelated buckets when the API token is restricted to one bucket, so subtract their usage manually through a lower `R2_MAX_BYTES`.

R2 CORS must allow `GET` and `HEAD` from the exact Vercel origin and `http://127.0.0.1:5173` for local review. Allow the `Range` request header and expose `Accept-Ranges`, `Content-Length`, and `Content-Range`; complete-track seeking depends on byte-range delivery. Keep write methods and credentials out of the browser policy.

After generating the hosted review catalogue, `npm run verify:hosted` exercises a real clue through Web Audio and the complete result-screen stream. It is opt-in because it depends on network access to R2; the default `npm run verify:ui` remains self-contained.

The optional local-file fallback is still supported. Any file placed in `public/media` becomes an ordinary downloadable web asset and is subject to the host's upload limits.
