# Catalogue and difficulty

## Song format

Add one object per song to `public/catalog.json`:

```json
{
  "id": "malcolm-todd-earrings",
  "title": "Earrings",
  "artist": "Malcolm Todd",
  "album": "Malcolm Todd",
  "aliases": [],
  "artistAliases": [],
  "releaseYear": 2025,
  "genres": ["alternative", "r&b"],
  "difficulty": "easy",
  "familiarity": 92,
  "introRecognition": 81,
  "startAtMs": 0,
  "artwork": "/media/artwork/malcolm-todd-earrings.jpg",
  "audio": {
    "kind": "file",
    "src": "/media/audio/malcolm-todd-earrings.mp3"
  }
}
```

Use URL-style forward slashes even on Windows. Keep IDs and filenames lowercase, stable, and unique.

`aliases` is useful for alternate spellings. The game normalizes capitalization, accents, punctuation, `feat.`, `remastered`, and similar suffixes, but the player still chooses a canonical search result before guessing.

`album` is optional. When provided, result screens show `Artist · Album` beneath the song title.

## Familiarity is not lifetime streams

For this game, the relevant question is: **How likely are you or your girlfriend to recognize this song today?** Lifetime stream count is only weak supporting evidence.

For example, a current Malcolm Todd song can belong in Easy for your audience even if an older song has a billion streams. Age, algorithmic exposure, region, and your own listening habits all change familiarity.

Seed `familiarity` from 0–100 using this private-audience rubric:

| Component | Weight | Question |
|---|---:|---|
| Your two-person recognition | 60% | Would at least one of you know the title when hearing the hook? |
| Current relevance | 20% | Is it recent, trending, or actively circulating in your feeds? |
| Broader visibility | 10% | Was it a meaningful chart, playlist, radio, or social hit? |
| Longevity | 10% | Has it stayed culturally recognizable over time? |

This intentionally lets recent songs outrank older high-stream songs for your particular game.

## Intro recognition is separate

`introRecognition` asks how identifiable the beginning is, independent of fame:

- 90–100: a signature sound immediately identifies it
- 70–89: recognizable within roughly two seconds
- 50–69: recognizable after instrumentation or vocals arrive
- 30–49: generic, quiet, or delayed intro
- 0–29: silence, ambience, or an extremely confusable opening

Always listen to the actual prepared clip. Different masters, live editions, and preview segments can begin differently.

## Initial difficulty formula

Use the following as a guide rather than a rigid law:

```text
ease score = 0.65 × familiarity + 0.35 × introRecognition
```

| Ease score | Suggested mode |
|---:|---|
| 85–100 | Easy |
| 70–84 | Medium |
| 50–69 | Hard |
| 30–49 | Expert |
| 0–29 | Impossible |

Manual overrides are expected. A famous song with two seconds of silence may be more entertaining in Hard; a smaller song both players love may belong in Easy.

## Pool guidelines

- Begin with 30–50 songs per mode; expand after the loop feels good.
- Cap an artist at roughly three tracks in a mode.
- Avoid duplicate album, single, deluxe, and remastered versions.
- Mix eras and genres within the tastes of the two players.
- Keep “Impossible” obscure but still technically guessable.
- Use `startAtMs: 0` for true intros. Only change it to correct leading file padding, not to jump to the chorus.

## Later calibration

Once persistent statistics exist, player results should replace manual estimates. Useful measurements are:

- success rate by stage
- median seconds needed for a correct answer
- final miss rate
- whether only one of the two players knows the track

A practical automatic rule would move a song toward Easy when it is consistently solved early and toward Expert when it is missed after 8–15 seconds.
