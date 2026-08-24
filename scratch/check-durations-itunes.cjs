const fs = require('fs');
const https = require('https');

function search(query) {
  return new Promise((resolve) => {
    https.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=1&entity=song`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).results[0]); } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Helper to delay
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const candidates = JSON.parse(fs.readFileSync('data/song-candidates.json', 'utf8'));
  const sources = JSON.parse(fs.readFileSync('data/song-download-sources.local.json', 'utf8'));
  
  const flagged = [];
  
  console.log(`Checking ${sources.songs.length} songs against iTunes API...`);
  let count = 0;
  for (const song of sources.songs) {
    if (song.youtube) {
      const ytDurMs = song.youtube.durationSeconds * 1000;
      // Search format: Artist Title
      const query = `${song.artist} ${song.title}`.replace(/&/g, '').replace(/ft\./ig, '').replace(/feat\./ig, '');
      const result = await search(query);
      if (result && result.trackTimeMillis) {
        const diffMs = ytDurMs - result.trackTimeMillis;
        if (Math.abs(diffMs) > 4000) {
          flagged.push({
            id: song.id,
            title: song.title,
            artist: song.artist,
            ytDur: (ytDurMs / 1000).toFixed(1),
            itunesDur: (result.trackTimeMillis / 1000).toFixed(1),
            diffSeconds: parseFloat((diffMs / 1000).toFixed(1))
          });
        }
      }
      // Delay to avoid rate limits (20 requests per minute is safe, let's do 100ms)
      await delay(100);
    }
    count++;
    if (count % 50 === 0) console.log(`Processed ${count}...`);
  }
  
  flagged.sort((a, b) => Math.abs(b.diffSeconds) - Math.abs(a.diffSeconds));
  fs.writeFileSync('scratch/flagged-durations.json', JSON.stringify(flagged, null, 2));
  console.log(`Flagged ${flagged.length} songs with >4s duration difference.`);
}

main().catch(console.error);
