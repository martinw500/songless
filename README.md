# Songless

A private, local-first song-intro guessing game for two people. It plays progressively longer clips from the beginning of a track and keeps the audio catalogue on your own machine.

## Current state

The first playable version includes:

- Easy, Medium, Hard, Expert, and Impossible pools
- configurable 0.01, 0.1, 0.5, 2, 8, and 15 second stages
- precise playback through the Web Audio API
- searchable canonical answers and aliases
- wrong guesses, skips, reveal states, and no-repeat rounds
- five generated demo melodies, so no copyrighted audio is required to test it
- a JSON catalogue with familiarity and intro-recognition fields

## Run it

Requirements: Node.js 22 or newer and npm.

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite. Start on Easy, play the clip, search for `Neon Steps`, and submit it to verify the complete loop.

The stage pills on the right are controls, not labels. Toggle any duration to add or remove it from the round; the timeline rebuilds to match and the selection is remembered in that browser. At least one stage always remains enabled.

## Add your music

Put short intro clips in `public/media/audio`. That directory is ignored by Git, so audio will not accidentally be committed.

If you have `ffmpeg`, the preparation script converts audio you provide into compact 20-second MP3 clips:

```powershell
.\scripts\prepare-audio.ps1 -InputDirectory "D:\Music\Songless Picks"
```

Then replace the demo entries in `public/catalog.json`. See [docs/CATALOG.md](docs/CATALOG.md) for the exact format and difficulty rules.

At 96 kbps, a 20-second clip is about 240 KB. Roughly 500 clips would use about 117 MB, compared with several gigabytes for 500 complete songs. Artwork is optional and belongs in `public/media/artwork`.

## Commands

```powershell
npm run dev       # development server
npm run typecheck # TypeScript validation
npm run build     # production build
npm run preview   # preview the production build
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Catalogue and difficulty](docs/CATALOG.md)
- [Vercel deployment](docs/DEPLOYMENT.md)
- [UI quality and motion](docs/UI-QUALITY.md)

## Deploy

Vercel is configured as the default host. A production deployment is public and can be shared with your girlfriend or friends without requiring accounts:

```powershell
npx vercel@latest --prod
```

The site asks search engines not to index it, so it behaves like an unlisted public link, but anyone with the URL can open it. Deployment protection remains optional. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Media note

The project deliberately does not download music from YouTube or integrate Spotify playback. Add audio that you are entitled to use. The app and preparation script do not upload or distribute your source files.
