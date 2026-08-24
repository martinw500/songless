const { spawnSync } = require('child_process');
const fs = require('fs');

const flagged = JSON.parse(fs.readFileSync('scratch/flagged-actual-durations.json', 'utf8'));
const commands = [];

for (const song of flagged) {
  // If it's Señorita, we already fixed it via startAtMs
  if (song.id === 'shawn-mendes-camila-cabello-senorita') continue;

  const query = `ytsearch30:${song.artist} ${song.title} audio`;
  console.log(`\nSearching: ${query}`);
  const result = spawnSync('yt-dlp', ['--dump-single-json', '--flat-playlist', '--no-warnings', query], { encoding: 'utf8' });
  try {
    const entries = JSON.parse(result.stdout).entries;
    const targetDur = parseFloat(song.itunesDur);
    // Find a match within 2.5s
    let found = entries.find(e => e.duration && Math.abs(e.duration - targetDur) <= 2.5);
    
    // Also prefer official sources if multiple match
    const matches = entries.filter(e => e.duration && Math.abs(e.duration - targetDur) <= 2.5);
    if (matches.length > 0) {
      found = matches.find(e => e.channel && (e.channel.includes('Topic') || e.channel.includes('VEVO'))) || matches[0];
    }
    
    if (found) {
      console.log(`=> Found EXACT match: ${found.title} (${found.duration}s) by ${found.channel}`);
      commands.push(`node scripts/resolve-youtube-sources.mjs --id "${song.id}" --url "${found.url}" --reason "Fixed duration mismatch"`);
    } else {
      console.log(`=> No match found within 2.5s of ${targetDur}s.`);
    }
  } catch(e) {
    console.log(`=> Failed to parse result.`);
  }
}

fs.writeFileSync('scratch/run-fixes.ps1', commands.join('\n'));
console.log('Wrote fix commands to scratch/run-fixes.ps1');
