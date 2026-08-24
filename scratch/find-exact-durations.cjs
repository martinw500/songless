const { spawnSync } = require('child_process');
const fs = require('fs');

const flagged = JSON.parse(fs.readFileSync('scratch/flagged-durations.json', 'utf8'));

for (const song of flagged) {
  const query = `ytsearch30:${song.artist} ${song.title} audio`;
  console.log(`\nSearching: ${query}`);
  const result = spawnSync('yt-dlp', ['--dump-single-json', '--flat-playlist', '--no-warnings', query], { encoding: 'utf8' });
  try {
    const entries = JSON.parse(result.stdout).entries;
    const targetDur = parseFloat(song.itunesDur);
    let found = entries.find(e => e.duration && Math.abs(e.duration - targetDur) <= 2.5);
    
    if (found) {
      console.log(`=> Found EXACT match: ${found.title} (${found.duration}s) by ${found.channel}`);
      console.log(`=> URL: ${found.url}`);
      console.log(`node scripts/resolve-youtube-sources.mjs --id "${song.id}" --url "${found.url}" --reason "Fixed duration mismatch"`);
    } else {
      console.log(`=> No match found within 2.5s of ${targetDur}s.`);
      for (const e of entries.slice(0, 5)) {
        console.log(`   - ${e.title} (${e.duration}s)`);
      }
    }
  } catch(e) {
    console.log(`=> Failed to parse result.`);
  }
}
