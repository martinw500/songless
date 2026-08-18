# Vercel deployment

## Why Vercel instead of GitHub Pages

Both services can host this static Vite application. Vercel is the default because it handles a Vite project at the domain root, creates preview deployments automatically, and also offers optional access protection. GitHub Pages would work, but it requires repository-path configuration and a separate Actions workflow without improving this project.

A private Git repository does **not** make either deployed website private by itself. This project does not require privacy: a public URL is convenient for sharing with your girlfriend and friends.

## What is already configured

- `vercel.json` selects Vite, runs the production build, and serves `dist`.
- Every response gets `X-Robots-Tag: noindex, nofollow, noarchive`.
- `public/robots.txt` asks crawlers not to index any route.
- `.vercelignore` excludes development-only files but intentionally includes `public/media` for local CLI deployments.

Crawler directives reduce accidental search-engine discovery; they are not access control. Anyone with the deployment URL can open the game and directly request its audio files.

## Public production deployment

Deploy from the local working tree rather than Git integration. This lets Vercel include the audio and artwork that Git intentionally ignores.

From the project directory:

```powershell
npx vercel@latest --prod
```

Accept Vercel's Vite defaults when prompted. Vercel will print a stable production URL that can be sent to anyone.

This URL is public. There is no login requirement, and your friends do not need Vercel accounts.

The included `robots.txt` and response header ask search engines not to list it. This makes the deployment *unlisted*, not private. Remove those directives later if you want the game to be discoverable through search.

## Updating the deployed game

After changing the catalogue or adding media, update production from the same local directory:

```powershell
npx vercel@latest --prod
```

The stable production URL will move to the new deployment. This approach does not require committing audio to Git.

## Optional private mode

If you later decide to restrict access:

1. Open **Settings → Deployment Protection** in Vercel.
2. Enable Vercel Authentication for all deployments.
3. Invite specific viewers or create a shareable bypass link.
4. Verify the ordinary URL in an incognito browser.

Protection is an option, not a requirement for the game.

## Git integration limitation

Automatic Git deployments contain only committed repository files. Because `public/media/audio` and `public/media/artwork` are intentionally ignored, a Git-triggered deployment will contain the demo catalogue but not your local media.

Use local CLI deployments when real media must be included. If the project eventually uses an external media store, Git-triggered deployments can become the default.

## Audio visibility

Vercel serves everything in `public/media` as ordinary web files. Visitors can inspect network requests and download those clips even if the interface has no download button. A database would not prevent that; playable browser audio must ultimately be delivered to the listener.

For a few invited friends, storage and bandwidth should remain small because each prepared clip is only about 240 KB. If the site attracts a wider audience, move media to licensed object storage and revisit catalogue rights before promoting it.
