const fs = require('fs');
const data = require('./data/song-candidates.json');

const seen = new Map();
const toRemove = [];

function normalize(title, artist) {
    // we want to merge "One Dance" and "One Dance - Drake feat. Wizkid", so if the title is same and one artist is a substring of another, it's a duplicate.
    return title.toLowerCase().replace(/[^a-z0-9]/g, '') + '|' + artist.split(/ feat| ft| &| x |, /i)[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

data.songs.forEach((s, i) => {
    const key = normalize(s.title, s.artist);
    if (seen.has(key)) {
        const first = seen.get(key);
        // We will keep the first one and remove the second one.
        toRemove.push(i);
        console.log(`Duplicate found: ${s.title} by ${s.artist}`);
        console.log(`  Keeping: ${first.artist}`);
        console.log(`  Removing: ${s.artist}`);
    } else {
        seen.set(key, s);
    }
});

toRemove.reverse().forEach(i => {
    data.songs.splice(i, 1);
});

fs.writeFileSync('./data/song-candidates.json', JSON.stringify(data, null, 2));
console.log(`Removed ${toRemove.length} duplicates. Total songs now: ${data.songs.length}`);
