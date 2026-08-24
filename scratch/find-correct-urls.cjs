const { spawnSync } = require('child_process');
const fs = require('fs');

const flagged = JSON.parse(fs.readFileSync('scratch/flagged-durations.json', 'utf8'));

for (const song of flagged) {
  const query = `ytmsearch1:${song.artist} ${song.title}`;
  console.log(`Searching: ${query}`);
  const result = spawnSync('yt-dlp', ['--dump-single-json', '--flat-playlist', query], { encoding: 'utf8' });
  try {
    const item = JSON.parse(result.stdout).entries[0];
    console.log(`=> Found: ${item.title} (${item.duration}s) by ${item.channel}`);
    console.log(`=> URL: ${item.url}\n`);
  } catch(e) {
    console.log(`=> Failed to parse result.\n`);
  }
}
