const { execSync } = require('child_process');
const fs = require('fs');

function getRMS(file, start, duration) {
  const cmd = `ffmpeg -hide_banner -loglevel error -ss ${start} -t ${duration} -i "${file}" -af astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level -f null - 2>&1`;
  try {
    const out = execSync(cmd).toString();
    const match = out.match(/RMS_level=([-.\d]+)/g);
    if (!match) return -99;
    return parseFloat(match[match.length - 1].split('=')[1]);
  } catch (e) {
    return -99;
  }
}

const files = [
  'private-media/source/onerepublic-counting-stars.webm',
  'private-media/source/shawn-mendes-camila-cabello-senorita.webm',
  'private-media/source/post-malone-circles.webm',
  'private-media/source/j-cole-worldstar-interlude.webm'
];

for (const file of files) {
  if (fs.existsSync(file)) {
    console.log(`\n--- ${file} ---`);
    for (let i = 0; i < 20; i+=0.5) {
      console.log(`${i}s: ${getRMS(file, i, 0.5)} dB`);
    }
  } else {
    console.log(`Missing ${file}`);
  }
}
