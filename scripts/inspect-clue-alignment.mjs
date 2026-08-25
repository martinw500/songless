// Ad-hoc diagnostic: compares a prepared clue against its complete track to
// find the offset the clue was actually cut at, and prints the leading level
// profile of both. Answers "does this clue start late?" with a measurement
// rather than an inference from the catalogue's startAtMs.
import { execFileSync } from "node:child_process";

const id = process.argv[2];
if (!id) {
  console.error("Usage: node scripts/inspect-clue-alignment.mjs <song-id> [seconds]");
  process.exit(1);
}
const seconds = Number(process.argv[3] ?? 6);
const SAMPLE_RATE = 44100;
const HOP = Math.round(SAMPLE_RATE * 0.005); // 5 ms resolution

function decode(path, durationSeconds) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error",
    "-i", path,
    "-t", String(durationSeconds),
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "f32le",
    "-",
  ], { maxBuffer: 512 * 1024 * 1024 });
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

function envelope(samples) {
  const frames = [];
  for (let start = 0; start + HOP <= samples.length; start += HOP) {
    let sum = 0;
    for (let i = start; i < start + HOP; i += 1) sum += samples[i] * samples[i];
    frames.push(Math.sqrt(sum / HOP));
  }
  return frames;
}

const toDb = (value) => (value <= 1e-9 ? -Infinity : 20 * Math.log10(value));

const cluePath = `private-media/r2/clues/${id}.mp3`;
const fullPath = `private-media/r2/full/${id}.mp3`;
const clue = envelope(decode(cluePath, seconds));
const full = envelope(decode(fullPath, seconds + 3));

// Where does the clue sit inside the complete track? Slide the clue envelope
// over the opening of the full file and take the best normalised correlation.
let bestLag = 0;
let bestScore = -Infinity;
const compareFrames = Math.min(clue.length, Math.round(2 / 0.005));
for (let lag = 0; lag + compareFrames <= full.length; lag += 1) {
  let dot = 0;
  let clueNorm = 0;
  let fullNorm = 0;
  for (let i = 0; i < compareFrames; i += 1) {
    dot += clue[i] * full[lag + i];
    clueNorm += clue[i] * clue[i];
    fullNorm += full[lag + i] * full[lag + i];
  }
  const score = dot / (Math.sqrt(clueNorm * fullNorm) || 1);
  if (score > bestScore) {
    bestScore = score;
    bestLag = lag;
  }
}

const firstAudible = (frames, thresholdDb) => {
  const index = frames.findIndex((value) => toDb(value) > thresholdDb);
  return index < 0 ? null : index * 5;
};

console.log(`\n=== ${id} ===`);
console.log(`clue is cut ${bestLag * 5}ms into the complete track (correlation ${bestScore.toFixed(4)})`);
console.log("");
for (const [label, frames] of [["clue", clue], ["full", full]]) {
  console.log(`${label}: first frame above -60dB at ${firstAudible(frames, -60)}ms, above -40dB at ${firstAudible(frames, -40)}ms, above -30dB at ${firstAudible(frames, -30)}ms`);
}
console.log("");
console.log("ms     clue dB   full dB");
for (let i = 0; i < Math.min(60, clue.length); i += 1) {
  const clueDb = toDb(clue[i]);
  const fullDb = toDb(full[i]);
  const fmt = (value) => (value === -Infinity ? "  -inf" : value.toFixed(1).padStart(6));
  console.log(`${String(i * 5).padStart(4)}  ${fmt(clueDb)}    ${fmt(fullDb)}`);
}
