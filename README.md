# Songless

A browser-based song-intro guessing game. Players hear progressively longer clues, search the catalogue, and reveal the complete track after a win or loss.

## Current game

- 804 playable songs across Easy, Medium, Hard, Expert, and Impossible
- cumulative 0.01, 0.1, 0.5, 2, 8, and 15 second clue stages
- intro or main-hook starting modes
- multi-select era and broad-genre filters
- browser-persistent no-repeat cycles for every difficulty/filter combination
- Unicode-aware title, alias, and complete-artist search
- optional four-second auto reroll with Retry and Next controls
- compact clue files and complete reveal tracks hosted on Cloudflare R2
- responsive desktop and phone layouts

The tracked curation data currently contains 1,090 candidate records and an active 1,126-song intake longlist. `public/catalog.json` is the generated runtime catalogue.

## Run locally

Requirements: Node.js 22 or newer and npm.

```powershell
npm install
npm run dev
```

Vite prints the local URL. The game itself needs no Spotify account, database, or local media files because playable audio is served from R2.

## Catalogue maintenance

Song metadata and scores live in `data/song-candidates.json`. Permitted source audio, download manifests, caches, prepared media, credentials, and audit reports stay in ignored local paths.

The normal maintenance sequence is:

```powershell
npm run resolve:youtube
npm run audit:sources
npm run download:media
npm run prepare:r2 -- ".\private-media\source"
npm run audit:media-starts
npm run upload:r2:dry-run
npm run upload:r2
npm run provisional:catalog
npm run audit:provisional
```

Use an ID filter for small correction batches. Source identity, version, duration, album artwork, opening audibility, and R2 storage projection must pass before a song enters the catalogue. See [Song sourcing](docs/SONG-SOURCING.md) for the full workflow.

R2 and optional Spotify metadata credentials belong only in ignored `.env.local`. Copy `.env.example` as a template; never give secrets a `VITE_` prefix.

## Useful commands

```powershell
npm run dev                 # local development server
npm test                    # unit and data-invariant tests
npm run typecheck           # TypeScript validation
npm run build               # production build
npm run provisional:catalog # regenerate the playable catalogue
npm run audit:provisional   # validate playable songs, media, scores, and balance
npm run audit:coverage      # compare intake, candidates, and playable coverage
npm run check:r2            # inspect bucket usage without uploading
npm run verify:ui           # desktop and phone interaction regression audit
npm run verify:hosted       # opt-in real R2 playback smoke test
```

## Documentation

- [Changelog](CHANGELOG.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Catalogue and difficulty](docs/CATALOG.md)
- [Song sourcing](docs/SONG-SOURCING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [UI quality and motion](docs/UI-QUALITY.md)

## Deployment

Vercel hosts the application and feedback relay; Cloudflare R2 serves audio and artwork. Production requires `DISCORD_WEBHOOK_URL` only when the feedback form is enabled. R2 credentials are never needed by the deployed application.

```powershell
npx vercel@latest --prod
```

The repository and site are public. `robots.txt` and response headers discourage indexing but are not access control.
