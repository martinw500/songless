import fs from 'fs';
import path from 'path';

const candidatesPath = path.resolve('./data/song-candidates.json');
const data = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));

// 1. Deduplicate
const seen = new Map();
const toRemove = [];

function normalize(title, artist) {
    return title.toLowerCase().replace(/[^a-z0-9]/g, '') + '|' + artist.split(/ feat| ft| &| x |, /i)[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

data.songs.forEach((s, i) => {
    const key = normalize(s.title, s.artist);
    if (seen.has(key)) {
        const first = seen.get(key);
        toRemove.push(i);
        console.log(`Duplicate found: ${s.title} by ${s.artist}`);
    } else {
        seen.set(key, s);
    }
});

toRemove.reverse().forEach(i => {
    data.songs.splice(i, 1);
});

// 2. Fix bb to cc in artworks
let fixedArtwork = 0;
data.songs.forEach(s => {
    if (s.media?.artworkUrl && s.media.artworkUrl.includes('100x100bb.jpg')) {
        s.media.artworkUrl = s.media.artworkUrl.replace('100x100bb.jpg', '600x600cc.jpg');
        fixedArtwork++;
    }
    if (s.media?.artworkUrl && s.media.artworkUrl.includes('600x600bb.jpg')) {
        s.media.artworkUrl = s.media.artworkUrl.replace('600x600bb.jpg', '600x600cc.jpg');
        fixedArtwork++;
    }
});

// 3. Fix Wicked Games album explicitly
const wickedGames = data.songs.find(s => s.id === 'the-weeknd-wicked-games');
if (wickedGames) {
    wickedGames.album = "Trilogy";
    // Using a known Trilogy artwork URL for iTunes, or I can just use a generic square. Let's look up Trilogy iTunes artwork
    // Actually, I can just run resolve-itunes-metadata.mjs manually on this one song later, or just set it to empty and let the script fetch it.
    // Setting it to null so we re-fetch with the strict album name
    wickedGames.media.artworkUrl = null;
    console.log("Cleared Wicked Games artwork so it can be re-fetched.");
}

fs.writeFileSync(candidatesPath, JSON.stringify(data, null, 2));
console.log(`Removed ${toRemove.length} duplicates. Fixed ${fixedArtwork} artworks. Total songs now: ${data.songs.length}`);
