import fs from "node:fs";

async function itunes(term) {
  const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=10&country=us`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return (await response.json()).results ?? [];
}

function art(url) {
  return (url || "").replace(/100x100bb/, "600x600bb");
}

const queries = {
  "ariana-grande-boyfriend-with-social-house": {
    term: "boyfriend ariana grande social house",
    pred: (track) => /boyfriend/i.test(track.trackName) && /ariana/i.test(track.artistName),
  },
  "kendrick-lamar-all-the-stars-with-sza": {
    term: "All The Stars Kendrick Lamar SZA",
    pred: (track) => /all the stars/i.test(track.trackName) && /kendrick/i.test(track.artistName),
  },
  "calvin-harris-one-kiss-with-dua-lipa": {
    term: "One Kiss Calvin Harris Dua Lipa",
    pred: (track) => /^one kiss$/i.test(track.trackName) && /calvin harris/i.test(track.artistName),
  },
  "the-weeknd-one-of-the-girls-with-jennie-lily-rose-depp": {
    term: "One Of The Girls The Weeknd JENNIE",
    pred: (track) => /one of the girls/i.test(track.trackName) && /weeknd/i.test(track.artistName),
  },
};

const root = JSON.parse(fs.readFileSync("data/song-candidates.json", "utf8"));
for (const [id, query] of Object.entries(queries)) {
  const results = await itunes(query.term);
  const pick = results.find(query.pred) ?? results[0];
  if (!pick) {
    console.log("NO RESULT", id);
    continue;
  }
  const song = root.songs.find((entry) => entry.id === id);
  song.album = pick.collectionName;
  song.itunesDurationMs = pick.trackTimeMillis;
  song.itunesTrackUrl = pick.trackViewUrl;
  song.metadataStatus = "verified_itunes_search";
  song.metadataProvider = "itunes";
  song.media.artworkUrl = art(pick.artworkUrl100);
  song.media.artworkStatus = "verified_itunes_album_art_needs_r2";
  if (pick.releaseDate) song.releaseYear = Number(String(pick.releaseDate).slice(0, 4));
  console.log(id, "->", song.album);
}
fs.writeFileSync("data/song-candidates.json", `${JSON.stringify(root, null, 2)}\n`);
