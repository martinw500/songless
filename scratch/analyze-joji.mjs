import { spawnSync } from 'child_process';
const result = spawnSync('ffmpeg', [
  '-i', 'private-media/source/joji-worldstar-money-interlude.webm',
  '-t', '15',
  '-af', 'astats=metadata=1:reset=1:length=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
  '-f', 'null',
  '-'
]);
const out = result.stderr.toString();
const lines = out.split('\n');
let levels = [];
for (const line of lines) {
  const match = line.match(/lavfi\.astats\.Overall\.RMS_level=([-.\d]+)/);
  if (match) {
    levels.push(parseFloat(match[1]));
  }
}
for (let i = 0; i < levels.length; i++) {
  if (i % 5 === 0) {
    console.log((i * 0.1).toFixed(1) + 's: ' + levels[i].toFixed(1) + ' dB');
  }
}
