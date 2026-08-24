const fs = require('fs');
const https = require('https');
require('dotenv').config({ path: '.env.local' });

async function getSpotifyToken() {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const req = https.request('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).access_token); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write('grant_type=client_credentials');
    req.end();
  });
}

async function fetchTracks(token, ids) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.spotify.com/v1/tracks?ids=${ids.join(',')}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { 
          const json = JSON.parse(data);
          if (!json.tracks) console.log(json);
          resolve(json.tracks || []); 
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const token = await getSpotifyToken();
  const candidates = JSON.parse(fs.readFileSync('data/song-candidates.json', 'utf8'));
  const sources = JSON.parse(fs.readFileSync('data/song-download-sources.local.json', 'utf8'));
  
  const validSongs = candidates.songs.filter(s => s.spotifyUrl);
  const spotifyDurations = {};
  for (let i = 0; i < validSongs.length; i += 50) {
    const batch = validSongs.slice(i, i + 50);
    const ids = batch.map(s => {
      const parts = s.spotifyUrl.split('/');
      return parts[parts.length - 1].split('?')[0];
    });
    const tracks = await fetchTracks(token, ids);
    for (let j = 0; j < tracks.length; j++) {
      if (tracks[j]) {
        spotifyDurations[batch[j].id] = tracks[j].duration_ms;
      }
    }
  }

  let flagged = [];
  for (const song of sources.songs) {
    if (song.youtube) {
      const ytDurMs = song.youtube.durationSeconds * 1000;
      const spDurMs = spotifyDurations[song.id];
      if (spDurMs) {
        const diffMs = ytDurMs - spDurMs;
        if (Math.abs(diffMs) > 3000) {
          flagged.push({
            id: song.id,
            title: song.title,
            diffSeconds: parseFloat((diffMs / 1000).toFixed(1))
          });
        }
      }
    }
  }
  
  flagged.sort((a, b) => Math.abs(b.diffSeconds) - Math.abs(a.diffSeconds));
  fs.writeFileSync('scratch/flagged-durations.json', JSON.stringify(flagged, null, 2));
  console.log(`Flagged ${flagged.length} songs with >3s duration difference.`);
  console.log(flagged.slice(0, 30));
}

main().catch(console.error);
