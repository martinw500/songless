const fs = require('fs');

const sourcesFile = 'data/song-download-sources.local.json';
const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));

const updates = {
  "bruno-mars-versace-on-the-floor": "https://www.youtube.com/watch?v=3JbmE3jjCSk",
  "psy-gangnam-style": "https://www.youtube.com/watch?v=CVxMTl6cUSE",
  "olivia-dean-so-easy-to-fall-in-love": "https://www.youtube.com/watch?v=FX1_FXlKxXY",
  "katy-perry-california-gurls": "https://www.youtube.com/watch?v=3SAGiMsxjw0",
  "kehlani-folded": "https://www.youtube.com/watch?v=14PLRhIEAy8",
  "eminem-mockingbird": "https://www.youtube.com/watch?v=FjVjHkezTIM",
  "rose-bruno-mars-apt": "https://www.youtube.com/watch?v=8Ebqe2Dbzls"
};

for (const song of sources.songs) {
  if (updates[song.id]) {
    song.url = updates[song.id];
    song.youtube.manualReviewReason = "Forced manual override for duration fix";
    console.log(`Updated ${song.id} to ${song.url}`);
  }
}

fs.writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + '\n', 'utf8');
