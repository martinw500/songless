const { spawnSync } = require('child_process');
const fs = require('fs');

const flagged = JSON.parse(fs.readFileSync('scratch/flagged-durations.json', 'utf8'));

for (const song of flagged) {
  const query = `ytsearch10:${song.artist} ${song.title} audio`;
  console.log(`Searching: ${query}`);
  const result = spawnSync('yt-dlp', ['--dump-single-json', '--flat-playlist', '--no-warnings', query], { encoding: 'utf8' });
  try {
    const entries = JSON.parse(result.stdout).entries;
    let found = entries.find(e => e.channel && (e.channel.includes('Topic') || e.channel.includes('- Topic')));
    if (!found) found = entries.find(e => e.title && e.title.includes('Audio') && !e.title.includes('Video'));
    if (!found) found = entries[0];
    console.log(`=> Found: ${found.title} (${found.duration}s) by ${found.channel}`);
    console.log(`=> URL: ${found.url}\n`);
  } catch(e) {
    console.log(`=> Failed to parse result.\n`);
  }
}
