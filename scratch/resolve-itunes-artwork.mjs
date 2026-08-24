import { readFileSync, writeFileSync } from "node:fs";
const candidateFile = "data/song-candidates.json";
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
let resolved = 0;
for (const song of candidateRoot.songs) {
  if (song.media?.artworkUrl) continue;
  try {
    const term = encodeURIComponent(song.title + " " + song.artist);
    const res = await fetch("https://itunes.apple.com/search?term=${term}&entity=song&limit=1");
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      let artwork = data.results[0].artworkUrl100;
      if (artwork) {
        artwork = artwork.replace("100x100bb", "600x600bb");
        song.media = song.media || {};
        song.media.artworkUrl = artwork;
        resolved++;
        console.log("Found iTunes artwork for: " + song.title);
      }
    }
  } catch (e) {
    console.error("Error for " + song.title, e.message);
  }
}
writeFileSync(candidateFile, JSON.stringify(candidateRoot, null, 2) + "\n");
console.log("Attached iTunes artwork to " + resolved + " songs.");
