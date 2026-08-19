# Song sourcing and first library

## Audience and admission rule

Songless targets an internet-aware North American audience aged roughly 18–24. Recognition wins over language, release era, or a single platform metric. A billion streams is an automatic reason to review a track, not an automatic reason to put it in the game.

## Intake longlist versus curated queue

The broad intake pool lives in `data/song-longlist.json`, with a readable copy in `data/song-longlist.txt`. Its source snapshot currently contains 1,125 tracks reported above one billion Spotify streams plus 450 founder/Gen-Z/current-recognition picks. After merging overlaps and applying exclusions, the generated pool contains 1,121 active songs only. Fifty-eight current prunes and 251 finalized removals are omitted rather than displayed beside usable songs. Of the active tracks, 106 have been explicitly accepted in `data/song-longlist-keeps.json`.

New-song discovery is frozen while the playable catalogue is implemented. Approved under-1B choices remain in the manual intake, while the unapproved proposal queue and its review machinery have been removed.

The source does not publish a reliable language field. Source-only rows therefore remain `languageReview: pending` instead of being guessed from a title or artist name. Manual additions and review decisions can explicitly mark a track `english`, `non_english`, or `multilingual`; the refresher validates and preserves that classification. Non-English retention is deliberate and limited to globally recognizable crossovers such as `Alors on danse`, `Gangnam Style`, `How You Like That`, `Gasolina`, and `Danza Kuduro`, rather than treating every international billion-stream track as suitable for this audience.

Taste-driven additions live in `data/song-manual-additions.json`. They are equally valid intake signals: “Who Knows,” “DAISIES,” and “Come Back to Earth” enter through founder recognition regardless of stream count. “august” remains visible as billion-stream evidence but is pruned as a documented founder mismatch. Recognition passes add high-circulation current songs, broad Gen-Z R&B and melodic-rap staples, and major 2000s/2010s childhood hits; they do not import an artist's catalogue merely because one song or the artist is popular. A novelty, joke, or aggressive rap sound circulating in short videos is not enough on its own: the full track should also have plausible deliberate listening value for this audience.

The shared personal playlist contributes recognition evidence only when a song already exists in the billion-stream or manual-addition pool; unmatched playlist songs are not imported. Spotify's unauthenticated public embed is capped at 100 tracks. If `data/founder-playlist-export.csv` exists, the refresher uses that full export instead; accepted headers are `Track Name` or `Title` and `Artist Name(s)` or `Artist`. Chinese-script rows are ignored while matching. `data/song-longlist-baseline.json` and `data/song-longlist-finalized-pass-4.json` contain approved exclusions and persistent crossover exceptions. `data/song-longlist-keeps.json` records accepted songs with a `reviewed_keep` signal, and `data/song-longlist-decisions.json` contains only the current prune batch.

Refresh the snapshot and merge manual additions with:

```powershell
npm run refresh:longlist
```

The longlist refresh is research-only. The playable application uses R2 or prepared local files; Spotify is optional metadata lookup only and never a playback source. The curated 120-song queue remains the only path toward intro scoring and promotion.

The tracked review queue contains 120 candidates in `data/song-candidates.json`:

| Primary bucket | Songs | Purpose |
|---|---:|---|
| Billion-stream anchors | 30 | Obvious, cross-platform hits |
| Current and recent | 30 | Songs still circulating strongly with the audience |
| Gen-Z staples | 30 | Taste-aligned artists and cohort favorites |
| Classics and throwbacks | 20 | Older songs that remain culturally active |
| Global crossovers | 10 | Recognizable non-English and international hits |

The queue is deliberately language-agnostic and caps each credited artist at three appearances. Its era balance is approximate rather than a reason to admit a weak song. Current chart research is recorded at the top of the candidate file; no chart or streaming API is used by the application.

## Candidate states

- `needs_media`: metadata and familiarity are ready, but the permitted clip is absent.
- `needs_intro_review`: the clip exists and must be heard at 0.1, 0.5, 2, 8, and 15 seconds.
- `approved`: the exact clip has an intro score, ease score, difficulty, and playable audio.
- `rejected`: the candidate failed metadata, media, recognizability, or game-quality review.

Do not guess `introRecognition` from the full song or a different master. Until the expected clip has been heard, `introRecognition`, `easeScore`, and `proposedDifficulty` remain `null`.

## R2 review and promotion workflow

1. Create a Cloudflare R2 bucket and an API token limited to Object Read & Write for that bucket. Connect a public custom domain or enable a temporary public development URL. Configure CORS for `GET`, `HEAD`, and byte-range playback from the local and production app origins.
2. Copy `.env.example` to ignored `.env.local` and configure the five `R2_` connection values. Leave `R2_MAX_BYTES` at 8.5 billion bytes or lower it when the account stores data elsewhere.
3. Run `npm run init:sources` to create or safely sync ignored `data/song-download-sources.local.json`; existing resolved URLs are preserved and removed candidate rows are dropped. `npm run resolve:youtube -- 10` fills a reviewable batch, while `npm run resolve:youtube -- 120` resolves every pending row. Selection prefers verified, artist, official, VEVO, and Topic channels; rejects live, karaoke, remix, sped/slowed, cover, edit, snippet, demo, compilation, and implausibly short or long results; and favors results containing every credited artist. `npm run audit:sources` independently checks completeness, aliases, title/artist agreement, durations, altered-version labels, duplicate video IDs, collaborator coverage, remaster warnings, and provenance before downloads.

   When no official upload is searchable, an exact full studio recording can be recorded with `node scripts/resolve-youtube-sources.mjs --id <id> --url <youtube-url> --reason <short-reason>`. Manual selection can override provenance only; title, artist, duration, altered-version, unexpected-feature, and combined-song checks still apply, and the reason remains in the ignored audit metadata.
4. Download and prepare complete 128 kbps tracks, 30-second clue assets, and optional artwork. Preparation requires exactly one media source per song, fails on continuous 30-second opening silence, and retains a 30 ms onset pad when trimming so the first transient is not clipped:

   ```powershell
   npm run resolve:youtube -- 10
   npm run audit:sources
   npm run download:media
   npm run prepare:r2 -- ".\private-media\source"
   ```

5. Validate the whole-bucket projection, then upload. The dry run and real upload both stop before writing when the projection exceeds the configured ceiling:

   ```powershell
   npm run upload:r2:dry-run
   npm run upload:r2
   npm run review:r2
   npm run dev
   ```

   The uploader gives catalogue URLs a media-version query and uses a one-hour R2 cache lifetime, so replacing a corrected source cannot leave devices pinned to an older immutable response.

6. Open `http://127.0.0.1:5173/?reviewSong=<id>` and confirm the exact version. Test 0.1, 0.5, 2, 8, and 15 seconds.
7. Audit the complete queue:

   ```powershell
   npm run audit:songs
   # or
   .\scripts\audit-song-library.ps1
   ```

8. Approve the exact hosted track with `npm run approve:song -- --id <id> --intro <0-100>`. If the master has genuine leading silence, add `--start-at <seconds>` (for example, `--start-at 2.4`) so both the clue and complete reveal treat that position as time zero. Add `--difficulty` and `--reason` only for a documented manual override.
9. Once at least ten approved songs exist in every difficulty, promote them:

   ```powershell
   npm run promote:songs
   ```

Promotion refuses to replace the five playable demos before that 50-song minimum is complete. Later runs promote every approved candidate, allowing the live pool to grow beyond the pilot. The result screen streams the complete R2 file from the exact reached timestamp.

## Local-file fallback

For a purely local build, name a permitted source after the candidate ID and run `.\scripts\prepare-audio.ps1 -InputDirectory "D:\Music\Songless Sources"`. The same audit, intro review, approval, and promotion rules apply.

## Curation principle

Familiarity and intro recognition remain separate. A Daniel Caesar track can outrank an older global hit for this audience, and a famous track with a quiet or generic opening can still land in Hard. See [CATALOG.md](CATALOG.md) for the schema and scoring rules.
