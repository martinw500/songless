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

Run `npm run audit:provisional` for the expanded playable testing catalogue. It validates every hosted candidate/catalogue mapping, unique IDs, R2 URLs and durations, start offsets, clue gains, tracked waveform features, deterministic score fields, difficulty counts, documented media-start overrides, and that rejected candidates cannot remain playable merely because their hosted media still exists.

Run `npm run audit:coverage` to compare the active billion-stream intake rows with candidate records and the playable catalogue. It reports separately which songs have never received a candidate record and which already have metadata but still lack playable media. The comparison is conservative normalized title/artist matching; review its reported edge cases before treating a near-match as the same recording.

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
> **Provisional intro scoring:** Waveform analysis can measure silence, level, onset, and an energy ramp, but it cannot determine whether a melody, beat, or voice is culturally unique. Until blind play-tested reviews exist, the waveform audibility proxy contributes only 10%; stream/broad reach contributes 50%, stored audience familiarity 20%, Gen-Z/current relevance 15%, and longevity 5%. Provisional fixed thresholds (78.1, 72.8, 68.7, and 66.8) keep the current modes comparably populated without randomly assigning songs. A quiet but distinctive opening can therefore remain easy, while a loud generic opening cannot dominate the rating. Once an intro receives a real identification review, the normal 45/35/15/5 formula and normal fixed thresholds apply.

## Audio onset calibration

MP3 files contain encoder padding (typically one full MP3 frame of 1152 samples ≈ 26ms) plus any genuine silence or fade-in at the start of the track. When the browser's Web Audio API decodes an MP3 to PCM via `decodeAudioData()`, this padding becomes real zero-valued samples at the start of the buffer. For extremely short playback stages (0.01s, 0.1s), even 50–300ms of leading silence makes the clip completely inaudible.

The `startAtMs` field in each candidate and catalog entry tells the audio engine where to begin playback inside the decoded buffer. `scripts/audit-media-starts.mjs` measures every complete/clue pair and stores tracked measurements in `data/intro-audio-features.json`.

### The clue-window gate

The only question that matters is whether the 0.1 second window the player actually hears contains audible music, so that is what the audit measures, on `private-media/r2/clues/<id>.mp3` — the same asset the browser requests for short stages, including its encoder priming and trim.

1. Decode the first 35 seconds of both prepared files to mono 44.1 kHz, 32-bit float PCM using ffmpeg, and take RMS on a 10 ms hop. That resolution matches the shortest stage in `stageOptions`; the previous 8 kHz / 50 ms envelope averaged the onset transient together with the silence beside it and routinely reported starts inside dead air.
2. Compute `bodyDb`, the median level over seconds 5–20, as a per-song loudness reference. Every threshold is relative to it. A fixed dBFS floor cannot separate a quiet analogue intro from digital silence across a catalogue this varied.
3. Split the 100 ms clue into five 20 ms sub-windows. The clue **passes** when at least four of the five sit within 26 dB of `bodyDb` (crediting `clueGainDb`) and no digital zero appears in the first 30 ms. One quiet sub-window is tolerated because that is what a note attack is; a clue that only carries energy in its tail is reported as `clue-window-silent`.
4. Compare the clue envelope with the complete file, reject alignment drift, and inspect the first two seconds plus the 8–15 second energy ramp.
5. Confirm the recording independently. Do not mistake audible video noise for a valid song onset; source title, artist credits, album, version label, and canonical duration must pass on their own.

### Correcting a failing start

`npm run provisional:catalog` moves a failing song to `musicOnsetMs`, the earliest start whose whole clue clears a stricter threshold: all five sub-windows within 20 dB of `bodyDb`. Holding a corrected start to the stricter bar leaves it comfortably inside the gate rather than on its boundary, and that margin also absorbs an MP3 seek that lands one frame (≈26 ms) early.

Two guards keep the correction honest:

- If the strict threshold is only reached more than 250 ms after the clue first sounds continuous, the song opens quietly on purpose and the gate boundary is used instead. Without this, a soft intro such as `system-of-a-down-chop-suey` would be skipped entirely in favour of the band entry 1.5 seconds later.
- The search starts at the configured start, so corrections only ever move forward. A measured onset before the configured start means the start was chosen deliberately, to open on a hook or skip an intro, and unwinding that is a human decision.

A failing clue window is an audible defect, so it corrects documented overrides too, rewriting their `startAtMs` and reason in `data/media-start-overrides.json`. Overrides stay authoritative for `clueGainDb` and for every song whose clue window already passes. Re-run `npm run audit:media-starts` after applying; the gate is self-consistent, so a corrected catalogue reports zero `clue-window-silent` songs.

`node scripts/verify-ui.mjs --hosted-smoke --hosted-id=<id>` confirms the result from the other end: it fetches the deployed R2 clue, decodes it with the browser's own MP3 decoder, and applies the same sub-window rule. That is the only check that includes decoder priming on the asset a player actually receives, so run it after an upload batch. It reads `public/review-catalog.json`, so regenerate that with `npm run review:r2` after changing any start.

### Investigating a "this song starts late" report

`npm run inspect:clue -- <song-id>` answers the two questions a start-time report raises, before any threshold is touched. It cross-correlates the prepared clue against the complete track to report the offset the clue was actually cut at, and prints the leading level profile of both at 5 ms resolution. A non-zero offset means the clue is mis-cut and the audio must be re-prepared; an offset of zero with a quiet profile means the start is landing in a lead-in and `startAtMs` is what needs to move.

Rendering the opening as a spectrogram distinguishes the two cases that a level meter cannot:

```powershell
ffmpeg -i private-media/r2/clues/<song-id>.mp3 -lavfi "atrim=0:1,asetpts=PTS-STARTPTS,showspectrumpic=s=1400x520:scale=log:gain=8:legend=1" intro.png
```

Broadband haze with no harmonic structure is a noise floor and should be skipped. Visible harmonic partials are a deliberately soft intro, which must be kept and raised with `clueGainDb` instead.

The gate deliberately tolerates a clue at its `-26 dB` floor, because that is what keeps genuinely soft intros such as `linkin-park-numb` intact. The cost is that a clue can pass while sitting more than 20 dB under its own body level, which sounds late even though it is not silent. `leon-thomas-mutt` was exactly that: a 5 ms envelope stays around `-35 dB` until `155 ms`, where it jumps to `-25 dB` and then to `-7.5 dB` by `225 ms`. Treat a passing clue with a large body-to-clue gap and a strong onset just outside the 100 ms window as a start-time bug, not as a gate failure.

A correctly calibrated start is still not sufficient on its own. The same smoke run also plays the 0.1 second stage with a 400 ms media start delay injected, because a clue window timed from `play()` returning will open and close before a phone's decoder and audio session produce sound — the start offset is then irrelevant and the player hears nothing. Desktop Chrome starts a media element almost instantly and hides this entirely, so the delay is injected rather than waited for. The assertion is that the element's own clock still advances a full clue's worth of audio.

The fallback chain for an unset start is: `song.startAtMs` → `song.media.onsetPadMs` → `30` (default LAME padding). Do not skip a deliberate fade or melody merely because it is soft. Set `clueGainDb` from 0–12 dB for those cases; clue playback is limited, and full-song reveal playback remains at the original level. Audible static cannot be distinguished reliably from intentional texture by level measurements, so known static receives an explicit skip such as the tracked `No One Noticed` override.

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

R2 artwork or optional metadata artwork is used when no local JPG exists. Album and Spotify-link metadata are display-only and optional; Spotify is never a playback source. Playable R2/local audio and verified intro scoring are mandatory. The first real catalogue needs at least ten songs in each mode and cannot mix demos with real songs. Hosted clues stream the compact clue asset through an HTML media element connected to the shared Web Audio gain graph. This keeps mobile Safari on the same reliable media route as the result reveal while retaining source offsets, timed stage cutoffs, pause/resume, clue-only gain, and live volume changes. A win or final loss streams the complete file from game-time zero rather than inheriting the final clue position.

### Artwork integrity

R2 object names do not prove that their contents are correct. Run `npm run audit:artwork:remote` after any bulk artwork upload. It reads R2 checksums and fails when identical image bytes are assigned to unrelated referenced candidates, even if every JSON URL and object key is unique. Legitimate shared release covers must be documented in `data/artwork-sharing-overrides.json` with the exact song IDs and a reason.

`npm run repair:artwork` is dry-run by default. It identifies the known poisoned checksum group and reports replacement coverage without changing R2. `node --env-file-if-exists=.env.local scripts/repair-poisoned-artwork-r2.mjs --apply` stages every replacement before uploading, enforces the R2 storage ceiling, writes a new content-hash cache-buster into candidate metadata, and verifies every resulting R2 checksum. Canonical cached Spotify artwork is preferred, followed by verified iTunes artwork; a song-specific local image is used only when neither canonical source is available. Unused candidates with no trustworthy replacement have their bad URL quarantined with `media.artworkStatus: "needs_canonical_artwork"`, so promotion uses the normal artwork fallback instead of reviving corrupt content.

An exact title, artist, duration, or audio fingerprint can still point to a licensed compilation carrying the same master. That does not make its presentation artwork the intended album cover. The audit therefore rejects unrelated sing-along, karaoke, workout, motivation, sound-alike, and generic hit-compilation album metadata unless the song has a documented review in `data/artwork-source-overrides.json`. Run `npm run apply:artwork-overrides` first for a source-only dry run, then `node --env-file-if-exists=.env.local scripts/apply-artwork-source-overrides.mjs --apply` to upload reviewed Spotify artwork, update the stable R2 key with a new content-hash cache-buster, and record the expected checksum. The remote artwork audit verifies that checksum on later runs.

Payphone intentionally uses the familiar `Overexposed (Deluxe)` artwork but does not expose a Spotify track link: the hosted 223-second non-rap master and Spotify's 231-second Wiz Khalifa album version are not the same edition. Artwork presentation may be reviewed independently, but a canonical track link must never claim an edition match that the audio does not satisfy.

Careless Whisper is the 5:00 single/video edition, not the 6:30 Make It Big album cut. That longer master is the same recording as the 12-inch extended mix, so players correctly hear it as the wrong version. The result screen keeps the familiar Make It Big artwork and names `Ladies & Gentlemen` as the album that actually carries this 5:00 master. The Spotify link and hosted duration must follow that hit.

## Search metadata

Use `aliases` for alternate titles, translations, and romanizations, and `artistAliases` for common artist spellings. Search normalization preserves letters and numbers from every Unicode script while remaining accent-, punctuation-, capitalization-, `feat.`, and version-insensitive. The player still selects a canonical result before submitting a guess.

Keep IDs and filenames lowercase, stable, and unique. `startAtMs` defines where game-time zero begins in a hosted or local source. Use it only to remove actual leading silence or master padding—not to jump ahead to a hook. Every clue and the complete result-screen restart apply the same offset.
