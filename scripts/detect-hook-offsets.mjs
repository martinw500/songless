import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hook Offset Detection via Audio Energy Analysis
 * 
 * Finds the "main part" of a song by detecting where energy ramps up
 * significantly — typically the first chorus or hook. This uses the same
 * concept as Spotify's preview selection: find the most energetic/recognizable
 * section and use it as the starting point.
 * 
 * Algorithm:
 * 1. Decode to low-rate mono PCM
 * 2. Compute short-term energy envelope (RMS in 200ms windows)
 * 3. Smooth the envelope
 * 4. Find the first sustained energy peak after the intro
 *    (skip the first few seconds to avoid counting intro percussion hits)
 * 5. Back up slightly before the peak to capture the build-up
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const verbose = process.argv.includes("--verbose");
const force = process.argv.includes("--force");
const limit = (() => {
  const arg = process.argv.find(a => a.startsWith("--limit="));
  return arg ? parseInt(arg.split("=")[1], 10) : Infinity;
})();

// Find ffmpeg
function findFfmpeg() {
  try {
    return execSync("where ffmpeg", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim().split("\n")[0].trim();
  } catch {
    const winget = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
    try {
      return execSync(`dir /s /b "${winget}\\ffmpeg.exe"`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim().split("\n")[0].trim();
    } catch {
      throw new Error("ffmpeg not found.");
    }
  }
}

const ffmpeg = findFfmpeg();

/** Decode audio to 8kHz mono f32le PCM. */
function decodeToPcm(filePath, maxSeconds = 0) {
  const timeLimit = maxSeconds > 0 ? `-t ${maxSeconds}` : "";
  const result = execSync(
    `"${ffmpeg}" -hide_banner -loglevel error -y -i "${filePath}" ${timeLimit} -f f32le -acodec pcm_f32le -ar 8000 -ac 1 -`,
    { maxBuffer: 100 * 1024 * 1024, encoding: "buffer" }
  );
  return new Float32Array(result.buffer, result.byteOffset, result.length / 4);
}

/** Compute RMS envelope. windowSamples=1600 at 8kHz = 200ms windows → 5 values/sec */
function computeEnvelope(samples, windowSamples = 1600) {
  const count = Math.floor(samples.length / windowSamples);
  const envelope = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sumSq = 0;
    const offset = i * windowSamples;
    for (let j = 0; j < windowSamples; j++) {
      const s = samples[offset + j];
      sumSq += s * s;
    }
    envelope[i] = Math.sqrt(sumSq / windowSamples);
  }
  return envelope;
}

/** Simple moving average smoothing. */
function smooth(envelope, radius = 5) {
  const result = new Float32Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(envelope.length - 1, i + radius); j++) {
      sum += envelope[j];
      count++;
    }
    result[i] = sum / count;
  }
  return result;
}

/**
 * Find the hook start time in seconds.
 * 
 * Strategy: find where the song first reaches a sustained high-energy
 * section. The "hook" is usually the first chorus, which is the first
 * time the energy level reaches near-peak and stays there.
 */
function findHookStart(envelope, framesPerSecond) {
  if (envelope.length < 20) return 0;

  // Compute the 85th percentile energy (typical chorus level)
  const sorted = [...envelope].sort((a, b) => a - b);
  const p85 = sorted[Math.floor(sorted.length * 0.85)];
  const p50 = sorted[Math.floor(sorted.length * 0.50)];
  
  // Threshold: energy must be above 70% of the way from median to p85
  const threshold = p50 + (p85 - p50) * 0.7;
  
  // Skip the first 5 seconds (intro percussion, sound effects, etc.)
  const startFrame = Math.min(Math.floor(5 * framesPerSecond), Math.floor(envelope.length * 0.1));
  
  // Look for the first sustained section above threshold
  // "Sustained" = at least 2 seconds continuously above threshold
  const sustainedFrames = Math.floor(2 * framesPerSecond);
  
  for (let i = startFrame; i < envelope.length - sustainedFrames; i++) {
    let allAbove = true;
    for (let j = 0; j < sustainedFrames; j++) {
      if (envelope[i + j] < threshold) {
        allAbove = false;
        break;
      }
    }
    if (allAbove) {
      // Back up 1 second to catch the build-up
      const hookFrame = Math.max(0, i - Math.floor(1 * framesPerSecond));
      return hookFrame / framesPerSecond;
    }
  }
  
  // Fallback: find the peak energy section in the first half
  let bestEnergy = 0;
  let bestFrame = 0;
  const halfLen = Math.floor(envelope.length * 0.6);
  const windowLen = Math.floor(3 * framesPerSecond); // 3-second window
  
  for (let i = startFrame; i < halfLen - windowLen; i++) {
    let energy = 0;
    for (let j = 0; j < windowLen; j++) {
      energy += envelope[i + j];
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestFrame = i;
    }
  }
  
  // Back up 0.5 seconds
  return Math.max(0, (bestFrame - Math.floor(0.5 * framesPerSecond)) / framesPerSecond);
}

// === Main ===
console.log("=== Hook Offset Detection via Audio Energy Analysis ===\n");

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const songs = candidateRoot.songs;

let processed = 0;
let skipped = 0;
let noFullTrack = 0;
let failed = 0;

for (const song of songs) {
  if (processed >= limit) break;

  if (song.hookStartMs != null && !force) {
    skipped++;
    continue;
  }

  const fullTrackPath = path.join(root, "private-media", "r2", "full", `${song.id}.mp3`);
  if (!existsSync(fullTrackPath)) {
    noFullTrack++;
    continue;
  }

  try {
    // Decode first 4 minutes to 8kHz mono
    const pcm = decodeToPcm(fullTrackPath, 240);
    
    // 200ms windows at 8kHz = 1600 samples/window → 5 frames/sec
    const windowSamples = 1600;
    const framesPerSecond = 8000 / windowSamples;
    
    const envelope = computeEnvelope(pcm, windowSamples);
    const smoothed = smooth(envelope, 3);
    
    const hookSeconds = findHookStart(smoothed, framesPerSecond);
    const hookMs = Math.round(hookSeconds * 1000);
    
    song.hookStartMs = hookMs;
    processed++;

    if (verbose) {
      console.log(`HOOK ${song.id}: ${hookSeconds.toFixed(1)}s`);
    } else {
      process.stdout.write(`\rProcessed: ${processed}`);
    }
  } catch (err) {
    failed++;
    if (verbose) console.log(`FAIL ${song.id}: ${err.message}`);
  }
}

if (!verbose) console.log("");

console.log(`\n=== Results ===`);
console.log(`Processed: ${processed}`);
console.log(`Skipped (already done): ${skipped}`);
console.log(`No full track: ${noFullTrack}`);
console.log(`Failed: ${failed}`);

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`\nWrote hookStartMs values to song-candidates.json.`);
