import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");

// --- Normalization ---
function normalized(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\b(feat|featuring|ft|with)\.?\b.*$/u, "")
    .replace(/\b(remaster(?:ed)?|radio edit|single version)\b.*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

async function run() {
  const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
  let resolved = 0;
  let failed = 0;

  for (const song of candidateRoot.songs) {
    if (song.media?.artworkUrl && !song.media.artworkUrl.includes('r2.dev')) {
      // Already has a non-YouTube artwork URL
      continue;
    }

    const query = encodeURIComponent(`${song.title} ${song.artist}`);
    const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=5`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      let bestMatch = null;
      for (const result of data.results) {
        // Basic safety check for artist and title
        const trackNameClean = normalized(result.trackName);
        const artistNameClean = normalized(result.artistName);
        const songTitleClean = normalized(song.title);
        
        if (trackNameClean.includes(songTitleClean) || songTitleClean.includes(trackNameClean)) {
           bestMatch = result;
           break;
        }
      }

      if (bestMatch) {
        song.album = song.album || bestMatch.collectionName;
        const artworkUrl = bestMatch.artworkUrl100?.replace('100x100bb.jpg', '600x600bb.jpg');
        if (artworkUrl) {
          song.media.artworkUrl = artworkUrl;
        }
        resolved++;
        console.log(`[OK] ${song.title} -> ${song.album}`);
      } else {
        failed++;
        console.warn(`[MISS] ${song.title}`);
      }
      
      // iTunes has a generous rate limit but 200ms is safe
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`Error on ${song.title}: ${err.message}`);
      failed++;
    }
  }

  writeFileSync(candidateFile, JSON.stringify(candidateRoot, null, 2) + "\n", "utf8");
  console.log(`\nResolved iTunes metadata for ${resolved} songs (${failed} missing).`);
}

run();
