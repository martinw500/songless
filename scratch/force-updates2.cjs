const fs = require('fs');

const sourcesFile = 'data/song-download-sources.local.json';
const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));

const updates = {
  "kehlani-folded": "https://www.youtube.com/watch?v=14PLRhIEAy8",
  "eminem-mockingbird": "https://www.youtube.com/watch?v=FjVjHkezTIM",
  "rose-bruno-mars-apt": "https://www.youtube.com/watch?v=8Ebqe2Dbzls",
  "lisa-money": "https://www.youtube.com/watch?v=vrZA5m4DBr4",
  "katy-perry-i-kissed-a-girl": "https://www.youtube.com/watch?v=Y5h7tmuh3HU"
};

for (const song of sources.songs) {
  if (updates[song.id]) {
    song.url = updates[song.id];
    song.youtube = song.youtube || {};
    song.youtube.manualReviewReason = "Forced manual override for duration fix";
    console.log(`Updated ${song.id} to ${song.url}`);
  }
}

fs.writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + '\n', 'utf8');
