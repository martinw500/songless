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
async function main() {
  const s1 = await search('Shawn Mendes Camila Cabello Senorita');
  console.log('Senorita:', s1 ? s1.trackTimeMillis : 'not found');
  const s2 = await search('The Weeknd Blinding Lights');
  console.log('Blinding Lights:', s2 ? s2.trackTimeMillis : 'not found');
}
main();
