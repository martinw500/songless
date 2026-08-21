
import { execSync } from 'node:child_process';
for (let i=0; i<3; i++) {
  try {
    const res = execSync('yt-dlp --dump-single-json --flat-playlist --no-warnings "ytsearch1:Billie Eilish bad guy audio"').toString();
    console.log(JSON.parse(res).entries.length);
  } catch (e) {
    console.log('failed');
  }
}

