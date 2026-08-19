# Catalogue and difficulty

## Intake records

`data/song-longlist.json` is the deliberately oversized discovery pool. A row records source rank and displayed stream band when available, billion/founder/personal-playlist signals, language-review state, and shortlist status. It is not loaded by the game and does not need full curation scores.

`data/song-manual-additions.json` is the editable lane for famous-artist tracks, Gen-Z staples, current social breakouts, and founder recognition. Manual rows may set `languageReview`; otherwise they default to English. `data/song-longlist-baseline.json` stores the original finalized exclusions and persistent crossover/social exceptions, while `data/song-longlist-finalized-pass-4.json` preserves the next approved removal batch. `data/song-longlist-keeps.json` stores accepted broad-recognition songs separately, giving them a `reviewed_keep` signal without pretending they came from the founder playlist. `data/song-longlist-decisions.json` stores only the current recoverable prune batch and can also correct a language classification. `npm run refresh:longlist` validates those values, merges exact matches, uses the available personal-playlist source only to tag supported candidates, omits all finalized exclusions, applies reviewed keeps and current prunes, and generates `data/song-pruned.txt`, `data/song-recent-additions.txt`, and `data/song-review-next.txt`. The next-review file now contains only active source ranks 650+ that still have no secondary or reviewed-keep signal. Run `npm run audit:songs` afterward to validate source and included counts, rejection reasons, states, signals, and language-review states.

New-song discovery is frozen while the playable catalogue is implemented. Previously approved under-1B choices remain in the manual intake; the pending proposal queue is no longer part of the runtime or audit workflow.

## Candidate records

`data/song-candidates.json` is the source-of-truth review queue. Each song stores canonical metadata, credited artists, aliases, language, genres, one primary sourcing bucket, selection signals, four familiarity components, review state, and expected media filenames.

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

Run `npm run audit:songs` after editing. The audit validates the 120-song and bucket totals, rough era distribution, three-song artist cap, IDs, aliases, score math, review transitions, media names, live catalogue, and approved difficulty counts.

## Familiarity

Familiarity estimates recognition by the target audience, not lifetime streams:

| Component | Weight | Question |
|---|---:|---|
| Audience recognition | 40% | Would a typical internet-aware 18–24-year-old know the title from the hook? |
| Current circulation | 25% | Is it current, revived, or still common in feeds and playlists? |
| Broader visibility | 20% | Did it cross charts, streaming, radio, film, or social media? |
| Longevity | 15% | Has recognition survived beyond its original release cycle? |

The audit recalculates the rounded weighted value and rejects mismatched `familiarity` fields.

## Intro recognition and difficulty

Only score the prepared clip:

- 90–100: a signature sound identifies it immediately
- 70–89: recognizable within roughly two seconds
- 50–69: recognizable after instrumentation or vocals arrive
- 30–49: generic, quiet, or delayed intro
- 0–29: silence, ambience, or an extremely confusable opening

```text
ease score = 0.50 × familiarity + 0.50 × introRecognition
```

| Ease score | Suggested mode |
|---:|---|
| 85–100 | Easy |
| 70–84.9 | Medium |
| 50–69.9 | Hard |
| 30–49.9 | Expert |
| 0–29.9 | Impossible |

Familiarity and intro recognition contribute equally. The audit permits a manual difficulty override only when `difficultyOverrideReason` explains it.

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

R2 artwork or optional metadata artwork is used when no local JPG exists. Album and Spotify-link metadata are display-only and optional; Spotify is never a playback source. Playable R2/local audio and verified intro scoring are mandatory. The first real catalogue needs at least ten songs in each mode and cannot mix demos with real songs. Hosted clues decode only the compact clue asset; a win or final loss streams the complete file from the timestamp the player reached.

## Search metadata

Use `aliases` for alternate titles, translations, and romanizations, and `artistAliases` for common artist spellings. Search normalization preserves letters and numbers from every Unicode script while remaining accent-, punctuation-, capitalization-, `feat.`, and version-insensitive. The player still selects a canonical result before submitting a guess.

Keep IDs and filenames lowercase, stable, and unique. `startAtMs` defines where game-time zero begins in a hosted or local source. Use it only to remove actual leading silence or master padding—not to jump ahead to a hook. Every clue and the complete result-screen continuation apply the same offset.
