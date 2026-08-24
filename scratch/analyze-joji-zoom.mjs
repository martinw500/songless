import { spawnSync } from 'child_process';
const result = spawnSync('ffmpeg', [
  '-i', 'private-media/source/joji-worldstar-money-interlude.webm',
  '-ss', '6',
  '-t', '2',
  '-af', 'astats=metadata=1:reset=1:length=0.01,ametadata=print:key=lavfi.astats.Overall.RMS_level',
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
  if (levels[i] < -45 || levels[i] > -30) {
    console.log((6 + i * 0.01).toFixed(2) + 's: ' + levels[i].toFixed(1) + ' dB');
  }
}
