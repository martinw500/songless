# Songless

A private song-intro guessing game for two people. It plays progressively longer clues from compact Cloudflare R2 assets, then streams the complete self-hosted track after the reveal.

## Current state

The first playable version includes:

- Easy, Medium, Hard, Expert, and Impossible pools
- configurable 0.01, 0.1, 0.5, 2, 8, and 15 second stages
- precise clue playback through compact Web Audio assets with complete-track continuation from R2
- searchable canonical answers and aliases
- wrong guesses, skips, reveal states, and no-repeat rounds
- five generated demo melodies, so no copyrighted audio is required to test it
- a JSON catalogue with familiarity and intro-recognition fields
- a curated 120-song Gen-Z review queue with language-agnostic search aliases
- a refreshable 1,179-record review pool built from a 1,125-song billion-stream snapshot plus selective sub-billion additions, with 1,120 active songs, 251 finalized exclusions, 59 current pruning decisions, 105 explicit reviewed keeps, and no unresolved 1B+ review tracks
- a frozen broad intake snapshot for future expansion, while the current implementation focuses on the curated 120
- audited promotion tooling that keeps incomplete real songs out of the live game

## Run it

Requirements: Node.js 22 or newer and npm.

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite. Start on Easy, play the clip, search for `Neon Steps`, and submit it to verify the complete loop.

The stage pills on the right are controls, not labels. Toggle any duration to add or remove it from the round; the timeline rebuilds to match and the selection is remembered in that browser. At least one stage always remains enabled.

## Add complete songs through Cloudflare R2

1. Create an R2 bucket and an R2 API token restricted to Object Read & Write for that bucket. Enable a public custom domain or temporary `r2.dev` URL. In the bucket's CORS policy, allow `GET` and `HEAD` from `http://127.0.0.1:5173` and the final Vercel origin; allow the `Range` header and expose `Accept-Ranges`, `Content-Length`, and `Content-Range`.
2. Copy `.env.example` to ignored `.env.local` and add the R2 account ID, access-key ID, secret, bucket, and public base URL. Keep `R2_MAX_BYTES=8500000000`; the uploader refuses the entire batch before writing if the projected bucket size exceeds it.
3. Run `npm run init:sources` to generate an ignored 120-song source manifest, then add explicitly authorized source URLs as they become available. Download, encode, dry-run, and upload:

```powershell
npm run init:sources
npm run resolve:youtube -- 5
npm run download:media
npm run prepare:r2 -- ".\private-media\source"
npm run check:r2
npm run upload:r2:dry-run
npm run upload:r2
npm run sync:r2
npm run review:r2
npm run dev
```

The YouTube resolver favors official audio and artist/Topic channels while rejecting live, acoustic, remixed, sped-up, slowed, cover, karaoke, loop, and other altered versions. Work in small batches and review the recorded YouTube title and channel before upload. The downloader enables Node.js challenge handling and yt-dlp's maintained EJS component; keep yt-dlp current when YouTube changes its player.

The preparation step creates a complete 128 kbps MP3, a separate 30-second clue MP3, and optional 512px artwork. It physically removes detected digital silence from the beginning of both audio assets. Open `/?reviewSong=<candidate-id>` and test 0.1, 0.5, 2, 8, and 15 seconds. Approve with `npm run approve:song -- --id <candidate-id> --intro <0-100>`; add `--start-at 2.4` only when a quiet but non-silent video intro should also be skipped manually.

`npm run promote:songs` replaces the demos after at least ten playable songs are approved in every difficulty. R2 supplies the audio while Vercel hosts only the application and small catalogue JSON. A prepared local file remains available as a development fallback.

## Commands

```powershell
npm run dev       # development server
npm run typecheck # TypeScript validation
npm run build     # production build
npm test          # search and normalization tests
npm run audit:songs # candidate, media, and live-catalogue validation
npm run init:sources # generate the ignored 120-song authorized-source worksheet
npm run resolve:youtube -- 5 # select studio/original YouTube sources in a reviewable batch
npm run download:media # download explicit URLs from the ignored authorized-source manifest
npm run prepare:r2 -- ".\private-media\source" # encode full and clue assets
npm run check:r2 # verify credentials and inspect current bucket usage without local media
npm run upload:r2:dry-run # verify the whole-bucket storage projection without uploading
npm run upload:r2 # guarded R2 upload and candidate URL update
npm run sync:r2 # verify existing objects and refresh catalogue URLs without uploading
npm run review:r2 # build the temporary hosted intro-review catalogue
npm run metadata:spotify # optional local-only album artwork/name/link lookup; never used for playback
npm run prepare:media -- -InputDirectory "D:\Music\Songless Sources" # prepare permitted audio and embedded covers
npm run approve:song -- --id <id> --intro <0-100> # score and approve a prepared song
npm run promote:songs # build the live catalogue from approved candidates
npm run refresh:longlist # refresh the external 1B+ snapshot and merge manual picks
npm run verify:ui # browser regression audit for stages, play icon, and volume
npm run review:r2; npm run verify:hosted # real R2 clue and full-song playback check
npm run verify:ui:artifacts # audit and save a screenshot for inspection
npm run preview   # preview the production build
```

To audit metadata, scoring, balance, and local media readiness:

```powershell
.\scripts\audit-song-library.ps1
```

The readable lists are `data/song-list.txt` for the curated 120 and `data/song-longlist.txt` for the frozen broad intake pool. Accepted taste-driven tracks remain in `data/song-manual-additions.json`; the pending under-1B discovery queue has been removed while implementation focuses on playable media. The public Spotify embed exposes only 100 playlist tracks. To match the complete playlist during a future refresh, add `data/founder-playlist-export.csv` with `Track Name`/`Title` and `Artist Name(s)`/`Artist` columns.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Catalogue and difficulty](docs/CATALOG.md)
- [Song sourcing and first library](docs/SONG-SOURCING.md)
- [Vercel deployment](docs/DEPLOYMENT.md)
- [UI quality and motion](docs/UI-QUALITY.md)

## Deploy

Vercel hosts the application while complete-song audio streams from R2:

```powershell
npx vercel@latest --prod
```

The site asks search engines not to index it, so it behaves like an unlisted public link, but anyone with the URL can open it. Deployment protection remains optional. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Playback note

R2 credentials and authorized source URLs stay in ignored local files. The browser receives only public media URLs. Full-track files are never committed to Git or uploaded with the Vercel application.
