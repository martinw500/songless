# Song sourcing and first library

## Recommendation

Do not make the first library every English-language track with one billion Spotify streams. The Billions Club is a useful source of obvious anchors, but it has four biases for this game:

- streaming-era releases have an advantage over older classics;
- brand-new culturally dominant songs have not had enough time to reach one billion;
- a small number of artists can occupy a disproportionate part of the pool;
- total streams do not measure whether the opening seconds are recognizable.

Start with a 120-song pilot:

| Bucket | Songs | Purpose |
|---|---:|---|
| Billion-stream anchors | 30 | Globally obvious modern hits |
| Current and recent | 30 | Songs circulating now, even below one billion |
| Shared/personal taste | 30 | Songs likely to be known by the actual players |
| Pre-streaming classics | 20 | Famous songs disadvantaged by platform age |
| Curveballs | 10 | Genre breadth and harder but fair rounds |

The first 30 proposed records are in `data/song-candidates.json`. They are a review queue, not the live catalogue.

## Spotify is research-only

The project must not integrate Spotify's API. Spotify's Developer Policy currently prohibits games, including trivia quizzes. The Web API's track `popularity` and `preview_url` fields are also deprecated, previews may be null, and preview clips cannot be offered as a standalone service.

Spotify's public Billions Club playlist can still inspire manual research, but do not fetch Spotify metadata, artwork, or audio into the game. Record ordinary facts such as title and artist independently and use media you are permitted to use.

- Policy: <https://developer.spotify.com/policy>
- Track API reference: <https://developer.spotify.com/documentation/web-api/reference/get-track>
- Spotify's Billions Club background: <https://newsroom.spotify.com/2024-12-18/spotify-presents-the-first-ever-billions-club-live-show-with-the-weeknd/>

## Audio workflow

1. Put source files you are allowed to use in a private folder outside the repository.
2. Name each source file after its candidate ID, such as `malcolm-todd-earrings.m4a`.
3. Run `scripts/prepare-audio.ps1` to create compact 20-second intro clips.
4. Run `scripts/audit-song-library.ps1` to see which candidates now have playable media.
5. Add permitted artwork to `public/media/artwork` or leave artwork blank.
6. Listen to the prepared beginning and assign `introRecognition` from the actual clip.
7. Move only complete entries into `public/catalog.json`.
8. Keep unlicensed audio out of public deployments. A private link does not itself grant redistribution rights.

Example:

```powershell
.\scripts\prepare-audio.ps1 -InputDirectory "D:\Music\Songless Sources"
.\scripts\audit-song-library.ps1
```

Both media directories are ignored by Git. Vercel can only serve a song if its audio is intentionally included in the deployment, so local testing is the appropriate first milestone.

## Selection and difficulty

Use billion-stream status as one familiarity signal, not as the admission rule. Give recent relevance and the two players' taste enough weight to let a newer song outrank an older streaming giant.

Keep `familiarity` and `introRecognition` separate. A universally famous track with a quiet or generic opening can still belong in Hard, while a smaller song with a signature first sound can be Easy for this audience. See [CATALOG.md](CATALOG.md) for the scoring rubric.
