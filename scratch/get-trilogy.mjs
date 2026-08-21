import fs from 'fs';

async function get() {
    try {
        let r = await fetch('https://music.apple.com/us/search?term=Wicked+Games+The+Weeknd+Trilogy');
        let h = await r.text();
        let m = h.match(/<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/);
        if (!m) return console.log("Regex failed on Apple Music HTML");
        
        let d = JSON.parse(m[1]);
        let sections = d[0].data.sections;
        let top = sections.find(s=>s.itemKind==='topResults')?.items[0];
        if (!top) top = sections.find(s=>s.itemKind==='tracks')?.items[0];
        
        let url = top.artwork.url.replace('{w}x{h}{c}.{f}', '600x600cc.jpg');
        console.log(url);
    } catch (e) {
        console.error(e);
    }
}
get();
