# Architecture

## Why there is no database yet

This version is intended for two people on a private machine. A database would require schema migrations, backups, authentication, and a server without improving the initial game.

The current storage split is:

| Data | Location | Git status |
|---|---|---|
| Song metadata | `public/catalog.json` | Tracked |
| Intro audio | `public/media/audio` | Ignored |
| Album artwork | `public/media/artwork` | Ignored |
| Volume preference | Browser local storage | Not applicable |
| Enabled clue stages | Browser local storage | Not applicable |
| Current round | React memory | Not persisted |

This remains comfortable for thousands of catalogue records. JSON size is not the limiting factor; audio storage is.

## Runtime flow

1. The React application loads `catalog.json`.
2. It validates the basic shape and creates difficulty pools.
3. A song is selected while avoiding repeats within the current pool.
4. The Web Audio API fetches and decodes its intro clip only when needed.
5. Skip changes the endpoint without scheduling audio. The first Play after advancing schedules only the new interval—for example, 2-8. After that interval completes, the next Play schedules the full cumulative 0-8 replay.
6. Guesses use catalogue IDs, avoiding ambiguous fuzzy-title comparisons.

Stage configuration is client-side. Toggling a duration stops active audio. Removing the current clue selects the next valid clue; adding a shorter clue makes that duration current so it is never misclassified as passed. Enabled durations are saved to local storage so playback state and the interface cannot disagree.

The first playback attempt sets a per-round stage lock. Both the native button `disabled` state and the toggle handler enforce it, so scripted or rapid clicks cannot mutate the timeline after play begins. Resetting the round clears the lock.

All available timeline segments remain mounted while the app is running. Disabled segments animate to zero width instead of being immediately removed from the DOM, allowing both additions and removals to produce a continuous reflow. The fills are separate absolutely positioned layers: translucent unlocked extent below, opaque played extent above, and transparent segment nodes with borders at the top. This keeps dividers visible without conflating unlocked and heard state. Win confetti is deterministic CSS motion rendered by React, requires no animation dependency, and is disabled by the reduced-motion stylesheet. See [UI-QUALITY.md](UI-QUALITY.md) for the visual acceptance rules.

The audio engine receives explicit start and end seconds and returns the actual scheduled range duration. File playback adds the range start to `startAtMs`; synthesized demos begin at the corresponding note index. The interface uses `requestAnimationFrame` to map absolute elapsed song time across the timeline. A run identifier cancels stale loading and animation work when the user stops playback, changes stages, changes difficulty, or leaves the round.

Decoded audio is cached in memory for replaying the current session. Refreshing the page clears that cache.

## Media strategy

Only the first 20 seconds are required because the longest clue is 15 seconds. The extra five seconds leave room for decoding and future stage adjustments. The preparation script outputs 96 kbps MP3 by default:

```text
20 seconds × 96 kilobits/second ÷ 8 ≈ 240 KB per track
```

The Git ignore rules prevent private media from being added to the repository. A production build will still copy media into `dist`, so do not upload that build to a public host unless the audio is cleared for distribution.

## When to add a database

Add SQLite or PostgreSQL only when one of these becomes real:

- separate user accounts
- shared multiplayer sessions across devices
- persistent solve statistics used to recalibrate difficulty
- an in-browser catalogue editor
- several independent catalogues

For a single computer, the next persistence step should be a small stats file or IndexedDB—not a hosted database.

## Deliberate boundaries

- No Spotify playback or Spotify-derived game integration
- No YouTube downloader
- No bulk media committed to Git
- No remote fonts, analytics, accounts, or external runtime services

The game therefore works offline after dependencies are installed and the local media exists.
