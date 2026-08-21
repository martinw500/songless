import { readFileSync, writeFileSync } from "node:fs";

const candidateFile = "data/song-candidates.json";
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const songs = candidateRoot.songs;

async function run() {
  let updated = 0;
  for (const song of songs) {
    if (!song.spotifyUrl) continue;
    // If it's already a Spotify CDN URL, skip
    if (song.media?.artworkUrl && song.media.artworkUrl.includes("scdn.co")) continue;
    
    try {
      const response = await fetch(song.spotifyUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (response.status === 429) {
         console.log("Web rate limit hit. Stopping.");
         break;
      }
      const html = await response.text();
      const match = html.match(/<meta property="og:image" content="(https:\/\/i\.scdn\.co\/image\/[^"]+)"/);
      if (match) {
        song.media.artworkUrl = match[1];
        updated++;
        console.log(`[${updated}] Updated ${song.title}`);
      } else {
        console.log(`Failed to find image for ${song.title}`);
      }
    } catch (err) {
      console.log(`Error on ${song.title}: ${err.message}`);
    }
    // Rate limit ourselves
    await new Promise(r => setTimeout(r, 300));
    
    if (updated % 20 === 0) {
      writeFileSync(candidateFile, JSON.stringify(candidateRoot, null, 2), "utf8");
    }
  }
  writeFileSync(candidateFile, JSON.stringify(candidateRoot, null, 2), "utf8");
  console.log(`Finished. Updated ${updated} songs.`);
}

run();
