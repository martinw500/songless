# Catalogue and difficulty

## Intake records

`data/song-longlist.json` is the deliberately oversized discovery pool. A row records source rank and displayed stream band when available, billion/founder/personal-playlist signals, language-review state, and shortlist status. It is not loaded by the game and does not need full curation scores.

`data/song-manual-additions.json` is the editable lane for famous-artist tracks, Gen-Z staples, current social breakouts, and founder recognition. Manual rows may set `languageReview`; otherwise they default to English. The baseline, finalized-pass, and current-decision JSON files are internal exclusion rules; they prevent pruned songs from reappearing after a source refresh. `data/song-longlist-keeps.json` stores explicit broad-recognition keeps such as “Notion.” `npm run refresh:longlist` applies those rules and writes only active tracks to `data/song-longlist.json` and the readable `data/song-longlist.txt`. It does not generate separate pruned, recent-addition, or review-next lists.

New-song discovery is frozen while the playable catalogue is implemented. Previously approved under-1B choices remain in the manual intake; the pending proposal queue is no longer part of the runtime or audit workflow.

## Candidate records

`data/song-candidates.json` is the source-of-truth review queue. Each song stores canonical metadata, credited artists, aliases, language, genres, one primary sourcing bucket, selection signals, four familiarity components, review state, and expected media filenames. When a public Spotify track page has been checked, `spotifyDurationMs` records the exact edition duration and `spotifyMetadataStatus: "verified_public_page"` records its provenance. These are build-time verification fields, not a playback dependency.

```json
{
  "id": "malcolm-todd-earrings",
  "title": "Earrings",
  "artist": "Malcolm Todd",
  "primaryArtists": ["Malcolm Todd"],
  "aliases": [],
  "artistAliases": [],
  "album": "Album title (optional)",
  "spotifyUrl": "https://open.spotify.com/track/example (optional)",
  "spotifyDurationMs": 172000,
  "spotifyMetadataStatus": "verified_public_page",
  "releaseYear": 2024,
  "genres": ["alternative", "r&b"],
  "language": "en",
  "bucket": "current_recent",
  "selectionSignals": ["current_chart", "taste_fit"],
  "scores": {
    "audienceRecognition": 80,
    "currentCirculation": 95,
    "broaderVisibility": 80,
    "longevity": 20
  },
  "familiarity": 75,
  "introRecognition": null,
  "easeScore": null,
  "proposedDifficulty": null,
  "difficultyOverrideReason": null,
  "reviewStatus": "needs_media",
  "media": {
    "audioFile": "malcolm-todd-earrings.mp3",
    "artworkFile": "malcolm-todd-earrings.jpg",
    "artworkUrl": "https://media.example.com/artwork/malcolm-todd-earrings.jpg",
    "hostedClueUrl": "https://media.example.com/audio/clues/malcolm-todd-earrings.mp3",
    "hostedFullUrl": "https://media.example.com/audio/full/malcolm-todd-earrings.mp3",
    "hostedDurationMs": 172000
  }
}
```

Run `npm run audit:songs` after editing. The audit validates IDs, aliases, score math, review transitions, media names, live catalogue entries, and approved difficulty counts. The original 120-song pilot composition remains curation history; the provisional playable catalogue is now larger.

Run `npm run audit:provisional` for the expanded playable testing catalogue. It validates every hosted candidate/catalogue mapping, unique IDs, R2 URLs and durations, start offsets, clue gains, tracked waveform features, deterministic score fields, difficulty counts, and documented media-start overrides.

Complete displayed artist credits are maintained separately from title aliases. Apply reviewed corrections from `data/artist-credit-overrides.json` with `npm run apply:artist-credits`; every override includes a reason so later metadata refreshes cannot silently discard or invent a featured artist.

## Recognition

Familiarity estimates recognition by the target audience, not lifetime streams:

| Component | Weight | Question |
|---|---:|---|
| Audience recognition | 40% | Would a typical internet-aware 18–24-year-old know the title from the hook? |
| Current circulation | 25% | Is it current, revived, or still common in feeds and playlists? |
| Broader visibility | 20% | Did it cross charts, streaming, radio, film, or social media? |
| Longevity | 15% | Has recognition survived beyond its original release cycle? |

The audit recalculates the rounded weighted value and rejects mismatched legacy `familiarity` fields. Runtime difficulty uses the explicit components below. A researched public stream milestone takes precedence over the pilot's hand-scored broader-visibility field; broader visibility and intake signals are fallbacks for tracks without a recorded stream total:

```text
ease score = 0.45 × intro recognition
           + 0.35 × stream/broad reach
           + 0.15 × Gen-Z/current relevance
           + 0.05 × longevity
```

`stream/broad reach` uses the stored billion-stream snapshot where available, on a logarithmic scale so five billion streams is meaningful without making every one-billion song equivalent. Under-one-billion founder picks receive conservative reach bands rather than invented exact counts. `Gen-Z/current relevance` uses the reviewed audience/circulation components or the longlist's Gen-Z, current-hit, social-revival, childhood-hit, and cohort signals. Its total contribution is capped at 15%, so social circulation cannot make a niche song Easy by itself. Longevity contributes the remaining 5%; candidates without researched longevity receive a neutral 50 until that metadata is added.

## Intro recognition and difficulty

Only score the prepared clip, while the title and artist are hidden. The question is when a listener can identify the exact song from the audio—not when sound merely becomes audible:

- 90–100: a signature sound identifies it immediately
- 70–89: recognizable within roughly two seconds
- 50–69: recognizable after instrumentation or vocals arrive
- 30–49: generic, quiet, or delayed intro
- 0–29: silence, ambience, or an extremely confusable opening

| Ease score | Suggested mode |
|---:|---|
| 82.6–100 | Easy |
| 79.2–82.5 | Medium |
| 75.9–79.1 | Hard |
| 72–75.8 | Expert |
| 0–71.9 | Impossible |

Intro identification is the largest single component at 45%. These fixed bands were calibrated once around the current library's score quintiles so each mode remains similarly playable; songs are never randomly assigned, and adding another song does not move an existing song by rank. `audit:provisional` requires at least 50 playable songs in every mode so a threshold change cannot silently create an unusably small pool. The audit permits a manual difficulty override only when `difficultyOverrideReason` explains it.

> [!NOTE]
> **Provisional intro scoring:** Waveform analysis can measure silence, level, onset, and an energy ramp, but it cannot determine whether a melody, beat, or voice is culturally unique. Until blind play-tested reviews exist, `scripts/generate-provisional-catalog.mjs` uses that measurement only as a `waveform_audibility_proxy`. It is provisional rather than evidence that the intro is identifiable. A blind time-to-identification `introRecognition` score replaces it.

## Audio onset calibration

MP3 files contain encoder padding (typically one full MP3 frame of 1152 samples ≈ 26ms) plus any genuine silence or fade-in at the start of the track. When the browser's Web Audio API decodes an MP3 to PCM via `decodeAudioData()`, this padding becomes real zero-valued samples at the start of the buffer. For extremely short playback stages (0.01s, 0.1s), even 50–300ms of leading silence makes the clip completely inaudible.

The `startAtMs` field in each candidate and catalog entry tells the audio engine where to begin playback inside the decoded buffer. `scripts/audit-media-starts.mjs` measures every complete/clue pair and stores safe tracked measurements in `data/intro-audio-features.json`. To set it correctly:

1. Decode the first 35 seconds of both prepared files to mono 8 kHz, 32-bit float PCM using ffmpeg.
2. Measure 50 ms RMS frames and find sustained first-sound, audible, and strong thresholds at -52, -42, and -32 dBFS.
3. Compare the clue envelope with the complete file, reject alignment drift, and inspect the first two seconds plus the 8–15 second energy ramp.
4. Document `startAtMs` at the earliest playable musical onset. Do not mistake audible video noise for a valid song onset; source title, artist credits, album, version label, and canonical duration must pass independently.

After applying onsets, regenerate the catalog with `node scripts/generate-provisional-catalog.mjs`. The fallback chain is: `song.startAtMs` → `song.media.onsetPadMs` → `30` (default LAME padding). Do not skip a deliberate fade or melody merely because it is soft. Set `clueGainDb` from 0–12 dB for those cases; clue playback is limited, and full-song reveal playback remains at the original level.

Because the shortest normal clue is 0.1 seconds, `npm run provisional:catalog` automatically advances an undocumented start that sits at least 100 ms before the measured sustained-audio onset. The audit verifies that normalization was applied instead of rejecting the song as a curation decision. Intentional quiet textures and fades must have a documented media-start override and, when necessary, clue-only gain. Audible static cannot be distinguished reliably from intentional texture by level measurements, so known static receives an explicit skip such as the tracked `No One Noticed` override.

## Live catalogue

`public/catalog.json` remains the runtime format. The promotion command prefers a complete R2-hosted source, then falls back to a prepared local file:

```json
{
  "id": "malcolm-todd-earrings",
  "title": "Earrings",
  "artist": "Malcolm Todd",
  "aliases": [],
  "artistAliases": [],
  "album": "Album title",
  "spotifyUrl": "https://open.spotify.com/track/example",
  "releaseYear": 2024,
  "genres": ["alternative", "r&b"],
  "difficulty": "easy",
  "familiarity": 75,
  "introRecognition": 90,
  "startAtMs": 0,
  "artwork": "https://i.scdn.co/image/example",
  "audio": {
    "kind": "hosted",
    "clueSrc": "https://media.example.com/audio/clues/malcolm-todd-earrings.mp3",
    "fullSrc": "https://media.example.com/audio/full/malcolm-todd-earrings.mp3",
    "durationMs": 172000
  }
}
```

R2 artwork or optional metadata artwork is used when no local JPG exists. Album and Spotify-link metadata are display-only and optional; Spotify is never a playback source. Playable R2/local audio and verified intro scoring are mandatory. The first real catalogue needs at least ten songs in each mode and cannot mix demos with real songs. Hosted clues decode only the compact clue asset; a win or final loss streams the complete file from game-time zero rather than inheriting the final clue position.

### Artwork integrity

R2 object names do not prove that their contents are correct. Run `npm run audit:artwork:remote` after any bulk artwork upload. It reads R2 checksums and fails when identical image bytes are assigned to unrelated referenced candidates, even if every JSON URL and object key is unique. Legitimate shared release covers must be documented in `data/artwork-sharing-overrides.json` with the exact song IDs and a reason.

`npm run repair:artwork` is dry-run by default. It identifies the known poisoned checksum group and reports replacement coverage without changing R2. `node --env-file-if-exists=.env.local scripts/repair-poisoned-artwork-r2.mjs --apply` stages every replacement before uploading, enforces the R2 storage ceiling, writes a new content-hash cache-buster into candidate metadata, and verifies every resulting R2 checksum. Canonical cached Spotify artwork is preferred, followed by verified iTunes artwork; a song-specific local image is used only when neither canonical source is available. Unused candidates with no trustworthy replacement have their bad URL quarantined with `media.artworkStatus: "needs_canonical_artwork"`, so promotion uses the normal artwork fallback instead of reviving corrupt content.

An exact title, artist, duration, or audio fingerprint can still point to a licensed compilation carrying the same master. That does not make its presentation artwork the intended album cover. The audit therefore rejects unrelated sing-along, karaoke, workout, motivation, sound-alike, and generic hit-compilation album metadata unless the song has a documented review in `data/artwork-source-overrides.json`. Run `npm run apply:artwork-overrides` first for a source-only dry run, then `node --env-file-if-exists=.env.local scripts/apply-artwork-source-overrides.mjs --apply` to upload reviewed Spotify artwork, update the stable R2 key with a new content-hash cache-buster, and record the expected checksum. The remote artwork audit verifies that checksum on later runs.

Payphone intentionally uses the familiar `Overexposed (Deluxe)` artwork but does not expose a Spotify track link: the hosted 223-second non-rap master and Spotify's 231-second Wiz Khalifa album version are not the same edition. Artwork presentation may be reviewed independently, but a canonical track link must never claim an edition match that the audio does not satisfy.

## Search metadata

Use `aliases` for alternate titles, translations, and romanizations, and `artistAliases` for common artist spellings. Search normalization preserves letters and numbers from every Unicode script while remaining accent-, punctuation-, capitalization-, `feat.`, and version-insensitive. The player still selects a canonical result before submitting a guess.

Keep IDs and filenames lowercase, stable, and unique. `startAtMs` defines where game-time zero begins in a hosted or local source. Use it only to remove actual leading silence or master padding—not to jump ahead to a hook. Every clue and the complete result-screen restart apply the same offset.
