# Songless handoff

Use this file when continuing Songless on another computer or in a new chat.

## Current state

- The curated candidate queue contains 120 songs.
- All 120 songs have a complete track, a 30-second clue MP3, and artwork hosted on Cloudflare R2.
- R2 contains 360 Songless objects using approximately 0.494 GB of the 8.5 GB safety ceiling.
- Leading digital silence was removed during preparation with a 30 ms onset pad to avoid clipping the first sound.
- Hosted URLs contain media-version queries so corrected files do not reuse stale browser caches.
- Every candidate currently has `reviewStatus: "needs_intro_review"`.
- The live `public/catalog.json` intentionally still contains the five demos. Real songs are not promoted until there are at least 10 approved, playable songs in every difficulty.
- The next task is intro review and difficulty assignment. Media does not need to be downloaded or uploaded again unless a specific source is wrong.

## Set up a new computer

Requirements: Git, Node.js 22 or newer, and npm.

```powershell
git clone https://github.com/martinw500/songless
cd songless
npm install
npm run review:r2
npm run dev
```

Open `http://127.0.0.1:5173/`. To open a specific hosted song directly, use:

```text
http://127.0.0.1:5173/?reviewSong=<candidate-id>
```

Candidate IDs are stored in `data/song-candidates.json`.

## Local-only files

These files are deliberately ignored by Git and are not present after cloning:

| File | Needed on the new computer? |
|---|---|
| `.env.local` | No for development, playback, intro review, scoring, or deployment. Needed only for R2 inspection, upload, replacement, or URL synchronization. |
| `data/song-download-sources.local.json` | No for normal work. Useful only when replacing or redownloading source media. |
| `private-media/` | No for normal work. It contains recoverable raw and prepared local media; the playable copies are already on R2. |
| `public/review-catalog.json` | Do not transfer it. Regenerate it with `npm run review:r2`. |

If R2 management is required, copy `.env.local` securely or recreate it from `.env.example`. Never paste its access keys into chat, commit it, or give a secret a `VITE_` prefix.

## Intro review and difficulty

For each exact prepared clue:

1. Listen at 0.1, 0.5, 2, 8, and 15 seconds.
2. Score `introRecognition` from 0 to 100 based on how quickly this audience can identify that exact opening.
3. Keep the existing familiarity calculation:

   ```text
   familiarity =
     0.40 × audienceRecognition +
     0.25 × currentCirculation +
     0.20 × broaderVisibility +
     0.15 × longevity
   ```

4. Calculate overall ease using equal weights:

   ```text
   easeScore = 0.50 × familiarity + 0.50 × introRecognition
   ```

5. Use the existing Easy through Impossible thresholds. Document any manual override.
6. Approve a reviewed song with:

   ```powershell
   npm run approve:song -- --id <candidate-id> --intro <0-100>
   ```

   Use `--start-at <seconds>` only when a quiet or non-silent video introduction must be skipped manually. Ordinary leading digital silence has already been removed from the actual files.

7. Run `npm run audit:songs` after approvals. Promote only after every difficulty has at least 10 approved playable songs.

## Required verification

Before handing work back:

```powershell
npm run typecheck
npm test
npm run build
npm run audit:songs
npm run verify:ui
git diff --check
```

Use `npm run verify:hosted` when hosted playback, media URLs, CORS, result-screen continuation, or R2 handling changes.

## Read before changing behavior

- `AGENTS.md`
- `README.md`
- `docs/CATALOG.md`
- `docs/SONG-SOURCING.md`
- `docs/ARCHITECTURE.md`
- `docs/UI-QUALITY.md`
- `docs/DEPLOYMENT.md`

## Copy-paste prompt for a new chat

> Read `AGENTS.md`, `HANDOFF.md`, `README.md`, and the relevant files under `docs/` before changing anything. Songless has a curated 120-song candidate queue, and all 120 full tracks, clue clips, and artwork files are already hosted on R2. Every candidate is currently `needs_intro_review`; the live catalogue still uses demos intentionally. Continue with exact-clip intro review at 0.1, 0.5, 2, 8, and 15 seconds, calculate ease using 50% familiarity and 50% intro recognition, document overrides, and promote songs only after every difficulty has at least 10 approved playable tracks. Do not redownload or re-upload media unless a specific hosted source is proven wrong. Preserve the existing interaction invariants and run the required verification commands before handoff.
