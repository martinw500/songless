# Architecture

## Why there is no database yet

This version is intended for two people sharing a static deployment. A database would require schema migrations, backups, authentication, and a server without improving the initial game. Cloudflare R2 owns media delivery; Songless stores static catalogue metadata.

The current storage split is:

| Data | Location | Git status |
|---|---|---|
| Song metadata | `public/catalog.json` | Tracked |
| Candidate queue and curation scores | `data/song-candidates.json` | Tracked |
| Broad intake snapshot | `data/song-longlist.json` | Tracked, generated |
| Founder/Gen-Z intake additions | `data/song-manual-additions.json` | Tracked |
| Finalized longlist exclusions | `data/song-longlist-baseline.json` | Tracked |
| Finalized recognition-pass archive | `data/song-longlist-finalized-pass-4.json` | Tracked |
| Explicit reviewed keeps | `data/song-longlist-keeps.json` | Tracked |
| Current recoverable pruning decisions | `data/song-longlist-decisions.json` | Tracked |
| Authorized raw sources and prepared audio | `private-media` | Ignored |
| Complete songs and compact clue assets | Cloudflare R2 | External |
| Hosted media URLs and duration | Candidate and live catalogue JSON | Tracked |
| Optional album/link metadata | Candidate and live catalogue JSON | Tracked |
| Optional local intro audio | `public/media/audio` | Ignored |
| Optional local album artwork | `public/media/artwork` | Ignored |
| Volume preference | Browser local storage | Not applicable |
| Auto-reroll preference | Browser local storage | Not applicable |
| Enabled clue stages | Browser local storage | Not applicable |
| Current round | React memory | Not persisted |

This remains comfortable for thousands of catalogue records. Complete audio is ignored locally and never copied into the repository or Vercel deployment.

Hosted media URLs include a version query derived from the prepared duration and silence trim. Stable R2 object keys can therefore be corrected without an older browser cache retaining a superseded encode; uploads use a one-hour cache lifetime while curation is active.

The candidate queue is intentionally separate from the live catalogue. `scripts/song-library.mjs` audits curation invariants and generates the runtime catalogue only from approved records. It refuses the first real promotion until every difficulty has ten playable songs, so missing media cannot silently create empty modes. The five synthesized demos remain live until that gate passes.

The longlist is one stage earlier than the candidate queue. `scripts/refresh-song-longlist.mjs` captures the public billion-stream research snapshot, merges editable founder/current picks, tags supported candidates that also appear in the personal playlist, removes finalized exclusions, applies explicit reviewed keeps, and then applies the current prune rules. Playlist matching uses `data/founder-playlist-export.csv` when supplied and otherwise falls back to Spotify's 100-track public embed preview. It generates one active-only JSON snapshot and one readable active-only text list. Pruned tracks remain only in internal exclusion rules so a refresh cannot accidentally restore them. The refresh never changes `public/catalog.json`; promoting a longlist track requires deliberate metadata, scoring, media, and intro review in the curated candidate queue.

## Runtime flow

1. The React application loads `catalog.json`.
2. It validates the basic shape and creates difficulty pools.
3. Hosted sources use a compact clue URL for timing and a complete-track URL for the reveal.
4. A song is selected while avoiding repeats within the current pool.
5. The audio engine decodes only the compact hosted clue asset. It switches to a streaming HTML audio element for the complete result track, avoiding a full-song download before every clue.
6. Skip changes the endpoint without scheduling audio. The first Play after advancing schedules only the new interval—for example, 2-8. After that interval completes, the next Play schedules the full cumulative 0-8 replay.
7. A win or final loss stops clue playback, restarts the selected intro or hook from game-time zero, and leaves it playing while the result is visible.
8. When the opt-in auto-reroll preference is enabled, the result displays a four-second countdown and then selects an unseen song from the current difficulty without immediately repeating the previous song. Cancelling pauses auto reroll for that result only; direct Retry and Next song controls provide immediate alternatives.
9. Guesses use catalogue IDs, avoiding ambiguous fuzzy-title comparisons.

Stage configuration is client-side. Toggling a duration stops active audio. Removing the current clue selects the next valid clue; adding a shorter clue makes that duration current so it is never misclassified as passed. Enabled durations are saved to local storage so playback state and the interface cannot disagree.

The first playback attempt sets a per-round stage lock. Both the native button `disabled` state and the toggle handler enforce it, so scripted or rapid clicks cannot mutate the timeline after play begins. Resetting the round clears the lock.

All available timeline segments remain mounted while the app is running. Disabled segments animate to zero width instead of being immediately removed from the DOM, allowing both additions and removals to produce a continuous reflow. The fills are separate absolutely positioned layers: translucent unlocked extent below, opaque played extent above, and transparent segment nodes with borders at the top. This keeps dividers visible without conflating unlocked and heard state. Win confetti is deterministic CSS motion rendered by React, requires no animation dependency, and is disabled by the reduced-motion stylesheet. See [UI-QUALITY.md](UI-QUALITY.md) for the visual acceptance rules.

The audio engine receives explicit start and end seconds and returns the actual scheduled range duration. For hosted and file sources, optional `startAtMs` padding is added to every requested range, so game-time zero can skip genuine leading silence without editing the stored recording. `clueGainDb` can raise an intentionally soft clue without moving game-time zero past its melody; a limiter protects boosted clue playback, while the full reveal retains the original master level. Every clue, synthesized source, and streamed reveal routes through one persistent master gain node, so moving or resetting the volume slider changes active playback immediately and the stored value also applies before the first Play. Hosted clues use the short asset; hosted reveals seek the complete asset to game-time zero. A hosted seek waits for the element's `seeked` event before playback begins, because a 0.1 second clue cannot absorb a seek that is still in flight. Synthesized demos begin at the corresponding note index. The interface uses `requestAnimationFrame` to map absolute elapsed song time across the timeline. Pausing stores that exact absolute timestamp as the next range start, so playback and the opaque timeline resume without snapping to a stage boundary. Skip intentionally replaces a partial pause point with the current endpoint before unlocking the next clue. Operation identifiers cancel stale playback requests when the user pauses, changes stages, changes difficulty, or leaves the round.

Decoded audio is cached with a three-song least-recently-used limit. A 60-second compressed file is small on disk but can occupy roughly 20 MB after browser decoding, so the bounded cache prevents a long session from retaining the entire library in memory. Refreshing the page clears the cache.

## Media strategy

Cloudflare R2 is the primary real-song source. Each authorized master produces a complete 128 kbps MP3 plus a 30-second clue MP3. For 1,000 average 3.5-minute tracks, complete audio is roughly 3.4 GB and clue assets roughly 0.5 GB before artwork.

The R2 uploader lists and totals the entire target bucket, accounts for replaced objects, and refuses the batch before uploading when its projection exceeds `R2_MAX_BYTES`. The default is 8.5 billion bytes, leaving headroom beneath a 10 GB account allowance. If the same Cloudflare account stores objects in other buckets, lower the configured ceiling by at least that amount.

Ignored local files remain a supported development fallback. The optional Spotify script attaches album artwork, album names, and outbound links only; it is not part of runtime playback.

## When to add a database

Add SQLite or PostgreSQL only when one of these becomes real:

- separate user accounts
- shared multiplayer sessions across devices
- persistent solve statistics used to recalibrate difficulty
- an in-browser catalogue editor
- several independent catalogues

For a single computer, the next persistence step should be a small stats file or IndexedDB—not a hosted database.
