# Opus 5 handoff: finish the next 200 songs

## Objective and non-negotiable result

Finish **exactly 200 additional playable songs** from the high-stream/broad-recognition queue. A song counts only after its recording, duration, silence trim/onset, canonical album metadata, per-song artwork, prepared clue/full files, R2 objects, and generated catalogue entry have passed verification. Do not upload a raw source merely because its title looks right.

The owner has configured R2 locally and has permission for the media workflow. Do not request or extract browser cookies. Do not print `.env.local`; it contains local-only R2 credentials. There must be no Spotify dependency at game runtime.

## Snapshot at handoff (2026-08-24)

- `data/song-candidates.json`: 1,089 candidates.
- `data/billion-download-batch.local.json`: 434 strict high-stream candidates: 200 existing + 234 newly added; 158 existing metadata records received a stricter album refresh.
- `data/song-download-sources.local.json`: 378/434 have a source URL after revalidation; 215 are explicitly fingerprint-gated, not trusted.
- `data/billion-media-selection.local.json`: verification set of 250 songs: 161 direct-provenance + 89 fingerprint-required; 126 more gated sources remain as reserve.
- The download pass finished with **235/250** selected source audio files. Fifteen failed because of age gates or a burst of YouTube HTTP 403/format responses; do not use cookies. Recalculate before resuming because a later retry may change this count.
- 81 selected songs already had prepared full/clue files; the whole local prepared manifest contained 692 tracks and used about 2.626 GiB.
- Last R2 check before this batch: about 2.575 GB, 2,044 objects, with `R2_MAX_BYTES=8.5GB`. **Nothing from this new batch has been uploaded in this session.**
- The live catalogue has not yet been regenerated with this batch.
- No commit or push was made.

Recalculate the moving download count:

```powershell
@'
import fs from "node:fs";
const s=JSON.parse(fs.readFileSync("data/billion-media-selection.local.json","utf8"));
const files=fs.readdirSync("private-media/source");
const audio=/\.(m4a|mp3|opus|ogg|wav|webm)$/i;
const done=s.selected.filter(x=>files.some(f=>f.startsWith(x.id+".")&&audio.test(f)));
console.log({selected:s.selectedCount,downloaded:done.length,remaining:s.selectedCount-done.length});
'@ | node --input-type=module -
```

Before resuming downloads, run `Get-Process yt-dlp -ErrorAction SilentlyContinue`. The downloader does not yet have a lock, so do not start a second copy while one is alive. The YouTube resolver *does* now use `data/resolve-youtube-sources.local.lock` and refuses concurrent writers. The failed IDs are `eminem-till-i-collapse`, `xxxtentacion-fuck-love`, `coldplay-sparks`, `justin-timberlake-can-t-stop-the-feeling-from-dreamworks-animation-s-trolls`, `nirvana-come-as-you-are`, `red-hot-chili-peppers-can-t-stop`, `xxxtentacion-everybody-dies-in-their-nightmares`, `maroon-5-this-love`, `juice-wrld-robbery`, `doja-cat-streets`, `the-script-the-man-who-can-t-be-moved`, `patrick-watson-je-te-laisserai-des-mots`, `michael-buble-it-s-beginning-to-look-a-lot-like-christmas`, `sza-nobody-gets-me`, and `harry-styles-late-night-talking`.

## What was implemented

### Candidate/metadata batching

- Added `scripts/prepare-billion-download-batch.mjs`.
- It builds a cached, resumable high-stream batch from `data/song-longlist.json`.
- Exact normalized title is now required; partial matches such as a different song whose title is only a substring are rejected.
- Altered versions include live, acoustic, remix, radio edit/mix, alternate version, reloaded, Taylor's Version, remaster differences, clean, karaoke, etc.
- Compilation/workout/fitness/body-by/megamix/sing-along artwork is rejected.
- Apple album selection strongly prefers an album artist matching the lead artist.
- `--refresh-existing` dry-runs/applies stricter album metadata to existing batch candidates.
- Important npm quirk: this installed npm swallowed `npm run batch:billion -- --target=500`. Invoke the script directly: `node scripts/prepare-billion-download-batch.mjs --target=...`.

### Source resolver hardening

- `scripts/resolve-youtube-sources.mjs` now supports batch files, revalidation, 1–8 bounded workers, 10–50 search depth, 45-second search timeouts, per-chunk persistence, and a PID lock.
- Strong sources require exact artist channel/Topic/audio/lyric evidence, title/credits/version checks, and canonical duration within three seconds.
- Verified artist music videos of exact duration and weak-provenance exact-duration mirrors are marked `requiresCanonicalFingerprint`; they are not considered verified yet.
- Revalidation rejects clean, radio-mix, remaster mismatch, 3D/8D/10D/7000D, 432 Hz, pitched, surround/headphone, live/remix/cover/karaoke/etc. labels.
- A previous terminated sequential resolver remained alive and overwrote a newer manifest. That exact stale process was stopped, and the new PID lock prevents recurrence.

### Downloads/preparation

- `scripts/download-authorized-sources.ps1` gained `-ContinueOnError`, per-failure reporting, `--socket-timeout 20`, bounded retries, and newline progress.
- It uses `--no-overwrites`, so reruns preserve finished files.
- One old source (`xxxtentacion-everybody-dies-in-their-nightmares`) was age-gated. It was excluded; do not use browser cookies to bypass it.
- `scripts/prepare-r2-media.ps1` already analyzes the first 30 seconds, trims detected leading silence while preserving a 30 ms pad, encodes full + 30-second clue MP3s at 128 kbps, and enforces the local 8.5 GB ceiling.
- Added `scripts/select-billion-media-batch.mjs`, which chose the 250-song verification set and excludes a fingerprint mismatch when the reference album agrees with the candidate album.

### Metadata helpers

- `scripts/resolve-deezer-metadata.mjs` and `scripts/resolve-studio-sources.mjs` now recognize locally prepared full files before R2 upload, enabling pre-upload references/fingerprints.
- `data/billion-candidate-metadata.local/` contains resumable Apple/Deezer batch caches, including `previewUrl` for newly refreshed results.

## Critical lessons and known traps

1. **Do not upload all 250 selected files.** The 89 gated files must first pass canonical fingerprints. Ideally fingerprint every selected track for which a reference exists.
2. **A matching duration is not recording proof.** The fingerprint pass caught real mismatches. `miguel-sure-thing` and `ariana-grande-into-you` were excluded from the 250 selection. `bastille-pompeii` looked like a mismatch only because Deezer selected an MTV Unplugged reference; its source duration matches the correct Apple `All This Bad Blood` recording. Reference-album agreement matters.
3. **Deezer can return the wrong edition.** It once selected an I Gotta Feeling megamix and a Pompeii unplugged track. Before relying on Deezer again, add `unplugged`, `megamix`, frequency/effect labels, and strict candidate-album agreement to its rejection logic.
4. **Apple/iTunes was returning HTTP 403 near handoff.** Use caches and avoid rapid refresh loops. The Spotify API is not required; credentials were removed from `.env.local` earlier.
5. **Known wrong album metadata still needing correction:**
   - `black-eyed-peas-i-gotta-feeling` currently says `Body by Jake: The Invigorator`; canonical album is `The E.N.D. (The Energy Never Dies)` (or its reviewed canonical release), and the cover must match that release.
   - `d4vd-here` / “Here With Me” currently says `Anti Love Songs`; use the reviewed canonical single/`Petals to Thorns` release and corresponding cover, not that compilation.
   - Audit all 42 existing batch records that did not receive a strict refresh; do not assume their current album art is canonical.
6. `black-eyed-peas-i-gotta-feeling` has stale `sourceStatus/sourceReview` text saying mismatch from a bad Deezer comparison. A later Apple/iTunes fingerprint matched the same source at distance `0.0675`. Clean the stale status only after fixing its canonical album/reference and rerunning the content-bound fingerprint.
7. The fallback deliberately found many unofficial audio/lyric mirrors. Their channel names are irrelevant after selection: only `canonical_match` (distance <= 0.18) may promote them. `probable_match` remains review-only.
8. Existing artwork history had a poisoned duplicate/Suicideboys-cover bug. Every new artwork object must use `artwork/<song-id>.jpg`, have a distinct verified source/checksum where appropriate, and pass `npm run audit:artwork:remote`. Never reuse one downloaded buffer across a loop.
9. `scripts/upload-artwork-r2.mjs` currently uploads every external artwork URL and has no `--id` filter. Add the same `--id`/`--id=` selection support as `upload-r2-media.mjs` before using it for this batch.
10. The result screen needs full playback from game-time zero. `startAtMs`/silence trimming must be consistently applied to clue and reveal. Do not reintroduce reveal playback continuing from 15 seconds.

## Exact remaining workflow

### 1. Finish/resume selected downloads

If no `yt-dlp` process is alive and fewer than 250 selected files exist:

```powershell
$ffmpegDir = 'C:\Users\marti\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin'
$env:PATH = "$ffmpegDir;$env:PATH"
$selection = Get-Content -Raw data/billion-media-selection.local.json | ConvertFrom-Json
$ids = @($selection.selected | ForEach-Object { $_.id })
& scripts/download-authorized-sources.ps1 -Ids $ids -ContinueOnError
```

Rerun the count and record any failures. Do not weaken checks or use cookies for failures.

### 2. Add/run a tracked duration audit before encoding

Convert the one-off duration check into a script that reads `billion-media-selection.local.json`, probes each source with the installed `ffprobe`, and compares it with both `source.youtube.durationSeconds` and `candidate.itunesDurationMs/spotifyDurationMs`. Reject missing/failed probes and canonical differences over three seconds. Persist an ignored report. Do not delete evidence; exclude/quarantine failed IDs.

### 3. Prepare only duration-passing IDs

```powershell
& scripts/prepare-r2-media.ps1 `
  -InputDirectory private-media/source `
  -FfmpegDirectory 'C:\Users\marti\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin' `
  -Ids $passingIds
```

Then inspect the trim report. Continuous 30-second silence is a hard failure. Also run `npm run audit:media-starts -- --id=<ids>` and correct quiet/static openings; do not merely reject fixable leading silence.

### 4. Finish canonical fingerprint coverage

Enhance `scripts/audit-canonical-fingerprints.mjs` to read strict references from `data/billion-candidate-metadata.local/` (those caches now include `previewUrl`) in addition to `itunes-track-metadata.local` and `deezer-track-metadata.local`. Match reference title, complete artists, candidate album, version, and duration before using a preview.

Run fingerprints on every selected row with `fingerprintRequired=true`; also fingerprint direct rows when a good preview exists:

```powershell
$env:FFMPEG_DIR='C:\Users\marti\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin'
node scripts/audit-canonical-fingerprints.mjs --id=<comma-separated-ids> --verbose
```

Only `canonical_match` is automatic proof. Exclude `probable_match`, `recording_mismatch`, incomplete credits, wrong-album references, and errors. Build a final ignored report with **exactly 200** IDs, preferring source-rank order and strong first-party sources. If fewer than 200 pass, pull more IDs from the 126 gated reserve in `song-download-sources.local.json`, then download/prepare/fingerprint only the shortfall.

### 5. Canonical album/artwork audit

For the final 200, verify title, complete artist credits, exact version, duration, canonical album, release year, and cover. Never accept compilation, karaoke, workout, generic “hits,” sing-along, or unrelated soundtrack art. Fix the two known album errors above and any suspicious records.

Add `--id` filtering to `upload-artwork-r2.mjs`. Its dry run must show only the final 200 (or the subset needing art), projected storage, and no mutation. Artwork is recommended, but wrong art is worse than a temporary fallback.

### 6. R2 dry run and guarded upload

First:

```powershell
npm run check:r2
node --env-file-if-exists=.env.local scripts/upload-r2-media.mjs --dry-run --id=<final-200-ids>
```

Confirm projected usage stays below 8.5 GB. Then upload audio for only the final IDs:

```powershell
node --env-file-if-exists=.env.local scripts/upload-r2-media.mjs --id=<final-200-ids>
```

Run the filtered artwork dry run, upload verified covers, and then `npm run audit:artwork:remote`. Check that audio/clue/artwork keys exist and candidate URLs have content-hash query versions.

### 7. Catalogue and gameplay verification

Regenerate the provisional catalogue only after the 200 hosted records are verified:

```powershell
npm run provisional:catalog
npm run audit:provisional
npm run audit:coverage
```

Difficulty must not be random. The current intended reviewed weighting is intro recognizability 45%, broad reach 35%, Gen-Z/current relevance 15%, longevity 5%, with balanced quantile allocation when intros are still provisional. Keep approximately even difficulty counts and inspect obvious outliers.

Run hosted smoke playback for representative new songs across every difficulty. Confirm mobile clue playback is audible, volume works during active playback, pause/resume/skip/timeline stay exact, result playback restarts at zero, and artwork follows the current song across rerolls.

### 8. Documentation and required checks

Update `docs/SONG-SOURCING.md` with the 434-candidate/250-verification-set workflow, resolver lock/concurrency/timeouts, fingerprint-gated mirrors, downloader continuation, exact-200 final selection, and filtered artwork upload.

Required before handoff:

```powershell
npm run typecheck
npm run build
npm run verify:ui
git diff --check
```

Also run the relevant source, duration, fingerprint, artwork, R2, catalogue, and hosted smoke audits. Do not claim 200 complete until all 200 are playable from R2 and present in the catalogue.

## Dirty tracked files at handoff

```text
M  .gitignore
M  data/song-candidates.json
M  package.json
M  scripts/download-authorized-sources.ps1
M  scripts/resolve-deezer-metadata.mjs
M  scripts/resolve-studio-sources.mjs
M  scripts/resolve-youtube-sources.mjs
?? scripts/prepare-billion-download-batch.mjs
?? scripts/select-billion-media-batch.mjs
?? docs/OPUS-5-HANDOFF.md
```

Preserve all user changes and inspect `git diff` before editing. Do not reset or discard the dirty worktree.
