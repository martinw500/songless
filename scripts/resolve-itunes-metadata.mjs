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
    
    let success = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const response = await fetch(url);
        if (response.status === 429) throw new Error("Rate limit");
        const data = await response.json();
        
        let bestMatch = null;
        let fallbackMatch = null;
        
        for (const result of data.results) {
          const trackNameClean = normalized(result.trackName);
          const songTitleClean = normalized(song.title);
          
          if (trackNameClean.includes(songTitleClean) || songTitleClean.includes(trackNameClean)) {
             const collectionName = (result.collectionName || '').toLowerCase();
             
             if (!fallbackMatch) fallbackMatch = result;

             if (song.album && normalized(collectionName).includes(normalized(song.album))) {
                 bestMatch = result;
                 break;
             } else if (!song.album && !collectionName.includes('highlights') && !collectionName.includes('greatest hits') && !collectionName.includes('essentials') && !collectionName.includes('best of') && !collectionName.includes('the singles')) {
                 bestMatch = result;
                 break;
             }
          }
        }
        
        bestMatch = bestMatch || fallbackMatch;

        if (bestMatch) {
          song.album = song.album || bestMatch.collectionName;
          const artworkUrl = bestMatch.artworkUrl100?.replace('100x100bb.jpg', '600x600cc.jpg');
          if (artworkUrl) {
            song.media.artworkUrl = artworkUrl;
          }
          resolved++;
          console.log(`[OK] ${song.title} -> ${song.album}`);
        } else {
          failed++;
          console.warn(`[MISS] ${song.title}`);
        }
        
        success = true;
        await new Promise(r => setTimeout(r, 200));
        break; // break retry loop

      } catch (err) {
        if (attempt === 5) {
          console.error(`Error on ${song.title}: ${err.message}`);
          failed++;
        } else {
          console.warn(`Rate limit on ${song.title}, retrying in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  writeFileSync(candidateFile, JSON.stringify(candidateRoot, null, 2) + "\n", "utf8");
  console.log(`\nResolved iTunes metadata for ${resolved} songs (${failed} missing).`);
}

run();
