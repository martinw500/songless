import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const sourceFile = path.join(root, "data", "song-download-sources.local.json");
const fingerprintReportFile = path.join(root, "data", "canonical-fingerprint-audit.local.json");
const outputFile = path.join(root, "data", "media-start-audit.local.json");
const publicFeaturesFile = path.join(root, "data", "intro-audio-features.json");
const verbose = process.argv.includes("--verbose");
const selectedIds = new Set(
  (process.argv.find((value) => value.startsWith("--id="))?.split("=")[1] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);
const limit = Number(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] ?? Number.POSITIVE_INFINITY);

function findTool(name) {
  const explicitDirectory = process.env.FFMPEG_DIR?.trim();
  if (explicitDirectory) {
    const explicit = path.join(explicitDirectory, `${name}.exe`);
    if (existsSync(explicit)) return explicit;
  }
  try {
    const located = execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/u)
      .find(Boolean);
    if (located) return located;
  } catch {
    // Fall through to the WinGet package search below.
  }

  const packages = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  if (existsSync(packages)) {
    const stack = [packages];
    while (stack.length > 0) {
      const directory = stack.pop();
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(entryPath);
        else if (entry.name.toLowerCase() === `${name}.exe`) return entryPath;
      }
    }
  }
  throw new Error(`${name} was not found. Set FFMPEG_DIR to the ffmpeg bin directory.`);
}

const ffmpeg = findTool("ffmpeg");
const ffprobe = findTool("ffprobe");
const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs;
const sourceRoot = existsSync(sourceFile) ? JSON.parse(readFileSync(sourceFile, "utf8")) : { songs: [] };
const sourceById = new Map(sourceRoot.songs.map((source) => [source.id, source]));
const fingerprintRoot = existsSync(fingerprintReportFile)
  ? JSON.parse(readFileSync(fingerprintReportFile, "utf8"))
  : { songs: [] };
const fingerprintById = new Map(fingerprintRoot.songs.map((entry) => [entry.id, entry]));

function decode(file, seconds = 35) {
  const buffer = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", file, "-t", String(seconds),
    "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
}

function durationMs(file) {
  const value = execFileSync(ffprobe, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { encoding: "utf8" }).trim();
  return Math.round(Number(value) * 1000);
}

const FRAME_SECONDS = 0.05;
const FRAME_SAMPLES = 8000 * FRAME_SECONDS;
function envelope(samples) {
  const frames = [];
  for (let offset = 0; offset + FRAME_SAMPLES <= samples.length; offset += FRAME_SAMPLES) {
    let sum = 0;
    let peak = 0;
    for (let index = offset; index < offset + FRAME_SAMPLES; index += 1) {
      const absolute = Math.abs(samples[index]);
      sum += samples[index] * samples[index];
      peak = Math.max(peak, absolute);
    }
    const rms = Math.sqrt(sum / FRAME_SAMPLES);
    frames.push({ rms, db: 20 * Math.log10(Math.max(rms, 1e-8)), peak });
  }
  return frames;
}

function firstSustained(frames, thresholdDb, sustainedFrames = 3) {
  for (let index = 0; index <= frames.length - sustainedFrames; index += 1) {
    let audible = 0;
    for (let cursor = 0; cursor < sustainedFrames; cursor += 1) {
      if (frames[index + cursor].db >= thresholdDb) audible += 1;
    }
    if (audible >= sustainedFrames - 1) return Math.round(index * FRAME_SECONDS * 1000);
  }
  return null;
}

function firstMostlyAudibleWindow(frames, thresholdDb = -45, windowFrames = 20, requiredRatio = 0.65) {
  for (let index = 0; index <= frames.length - windowFrames; index += 1) {
    let audible = 0;
    for (let cursor = 0; cursor < windowFrames; cursor += 1) {
      if (frames[index + cursor].db >= thresholdDb) audible += 1;
    }
    if (audible / windowFrames >= requiredRatio) return Math.round(index * FRAME_SECONDS * 1000);
  }
  return null;
}

function median(values) {
  if (values.length === 0) return -160;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function rangeMedian(frames, startSeconds, endSeconds) {
  const start = Math.floor(startSeconds / FRAME_SECONDS);
  const end = Math.min(frames.length, Math.ceil(endSeconds / FRAME_SECONDS));
  return median(frames.slice(start, end).map((frame) => frame.db));
}

function firstPlayableWindow(frames, clueGainDb, windowSeconds = 2) {
  const windowFrames = Math.round(windowSeconds / FRAME_SECONDS);
  const targetRawDb = -38 - clueGainDb;
  for (let index = 0; index <= frames.length - windowFrames; index += 1) {
    const windowDb = median(frames.slice(index, index + windowFrames).map((frame) => frame.db));
    if (windowDb >= targetRawDb) return Math.round(index * FRAME_SECONDS * 1000);
  }
  return null;
}

function envelopeCorrelation(left, right, lagFrames) {
  const leftStart = Math.max(0, -lagFrames);
  const rightStart = Math.max(0, lagFrames);
  const length = Math.min(left.length - leftStart, right.length - rightStart, 600);
  if (length < 40) return 0;
  const a = left.slice(leftStart, leftStart + length).map((frame) => frame.db);
  const b = right.slice(rightStart, rightStart + length).map((frame) => frame.db);
  const meanA = a.reduce((sum, value) => sum + value, 0) / length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / length;
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let index = 0; index < length; index += 1) {
    const deltaA = a[index] - meanA;
    const deltaB = b[index] - meanB;
    numerator += deltaA * deltaB;
    denominatorA += deltaA * deltaA;
    denominatorB += deltaB * deltaB;
  }
  return numerator / Math.sqrt(Math.max(1e-12, denominatorA * denominatorB));
}

function alignment(fullFrames, clueFrames) {
  let best = { lagMs: 0, correlation: -1 };
  for (let lag = -20; lag <= 20; lag += 1) {
    const correlation = envelopeCorrelation(fullFrames, clueFrames, lag);
    if (correlation > best.correlation) best = { lagMs: Math.round(lag * FRAME_SECONDS * 1000), correlation };
  }
  return { lagMs: best.lagMs, correlation: Math.round(best.correlation * 1000) / 1000 };
}

function sourceKind(source, song) {
  const fingerprint = fingerprintById.get(song.id);
  let hostedVersion = null;
  try {
    hostedVersion = new URL(song.media?.hostedFullUrl).searchParams.get("v");
  } catch {
    // The normal source classification below handles a malformed URL.
  }
  if (fingerprint?.status === "canonical_match"
    && fingerprint.contentVersion
    && fingerprint.contentVersion === hostedVersion) return "canonical_fingerprint";
  const title = source?.youtube?.title ?? "";
  const channel = source?.youtube?.channel ?? "";
  if (source?.youtube?.resolutionMethod === "canonical-acoustic-fingerprint") return "canonical_fingerprint";
  if (/\btopic\b/iu.test(channel)) return "topic";
  if (/\b(?:official )?audio\b/iu.test(title)) return "audio";
  if (/\blyrics?\b/iu.test(title)) return "lyrics";
  if (/\b(?:official )?(?:music )?video\b/iu.test(title)) return "music_video";
  if (source?.youtube?.channelVerified && source?.youtube?.resolutionMethod === "strict-studio-source-audit") return "verified_artist_release";
  if (source?.youtube?.resolutionMethod === "strict-studio-source-audit") return "strict_studio_match";
  if (source?.url) return "unknown_youtube";
  return "unresolved";
}

const reports = [];
let processed = 0;
for (const song of candidates) {
  if (selectedIds.size > 0 && !selectedIds.has(song.id)) continue;
  if (!song.media?.hostedFullUrl || !song.media?.hostedClueUrl) continue;
  if (processed >= limit) break;
  processed += 1;
  const fullFile = path.join(root, "private-media", "r2", "full", `${song.id}.mp3`);
  const clueFile = path.join(root, "private-media", "r2", "clues", `${song.id}.mp3`);
  const source = sourceById.get(song.id);
  const flags = [];
  if (!existsSync(fullFile) || !existsSync(clueFile)) {
    reports.push({ id: song.id, title: song.title, artist: song.artist, flags: ["missing-local-media"] });
    continue;
  }
  try {
    const fullFrames = envelope(decode(fullFile));
    const clueFrames = envelope(decode(clueFile));
    const configuredStartMs = song.startAtMs ?? song.media?.onsetPadMs ?? 30;
    const firstSoundMs = firstSustained(fullFrames, -52);
    const firstAudibleMs = firstSustained(fullFrames, -42);
    const firstStrongMs = firstSustained(fullFrames, -32);
    const firstMusicalMs = firstMostlyAudibleWindow(fullFrames);
    const introDb = rangeMedian(fullFrames, configuredStartMs / 1000, configuredStartMs / 1000 + 2);
    const laterDb = rangeMedian(fullFrames, configuredStartMs / 1000 + 8, configuredStartMs / 1000 + 15);
    const clueGainDb = song.clueGainDb ?? 0;
    const effectiveIntroDb = introDb + clueGainDb;
    const recommendedPlayableMs = firstPlayableWindow(fullFrames, clueGainDb);
    const aligned = alignment(fullFrames, clueFrames);
    const actualDurationMs = durationMs(fullFile);
    const kind = sourceKind(source, song);
    if (firstSoundMs !== null && configuredStartMs + 250 < firstSoundMs) flags.push("configured-before-first-sound");
    if (firstAudibleMs !== null && configuredStartMs + 100 <= firstAudibleMs) flags.push("short-clue-dead-zone");
    if (firstAudibleMs !== null && configuredStartMs + 600 < firstAudibleMs && clueGainDb === 0) flags.push("configured-before-audible-content");
    if (configuredStartMs > 1000) flags.push("manual-offset-over-1s");
    if (effectiveIntroDb < -38) flags.push("very-quiet-first-2s");
    if (laterDb - introDb >= 12) flags.push("large-intro-energy-ramp");
    if (Math.abs(aligned.lagMs) > 150 || aligned.correlation < 0.92) flags.push("clue-full-misaligned");
    if (Math.abs(actualDurationMs - song.media.hostedDurationMs) > 1000) flags.push("catalog-duration-mismatch");
    if (["music_video", "unknown_youtube", "unresolved"].includes(kind)) flags.push("source-needs-studio-audio-verification");
    reports.push({
      id: song.id,
      title: song.title,
      artist: song.artist,
      configuredStartMs,
      hookStartMs: song.hookStartMs ?? null,
      firstSoundMs,
      firstAudibleMs,
      firstStrongMs,
      firstMusicalMs,
      first2SecondsDb: Math.round(introDb * 10) / 10,
      clueGainDb,
      effectiveFirst2SecondsDb: Math.round(effectiveIntroDb * 10) / 10,
      recommendedPlayableMs,
      seconds8To15Db: Math.round(laterDb * 10) / 10,
      clueFullAlignment: aligned,
      actualDurationMs,
      catalogDurationMs: song.media.hostedDurationMs,
      sourceKind: kind,
      sourceTitle: source?.youtube?.title ?? null,
      sourceChannel: source?.youtube?.channel ?? null,
      flags,
    });
    if (flags.length > 0 || selectedIds.size > 0 || verbose) {
      console.log(`${flags.length ? "FLAG" : "PASS"} ${song.id}${flags.length ? `: ${flags.join(", ")}` : ""}`);
    }
  } catch (error) {
    reports.push({ id: song.id, title: song.title, artist: song.artist, flags: ["analysis-failed"], error: error.message });
    console.error(`FAIL ${song.id}: ${error.message}`);
  }
}

let completeReports = reports;
if (selectedIds.size > 0 && existsSync(outputFile)) {
  const previous = JSON.parse(readFileSync(outputFile, "utf8")).songs ?? [];
  const updated = new Map(reports.map((report) => [report.id, report]));
  completeReports = previous.map((report) => updated.get(report.id) ?? report);
  for (const report of reports) if (!previous.some((entry) => entry.id === report.id)) completeReports.push(report);
}
const flagCounts = {};
for (const report of completeReports) for (const flag of report.flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
const generatedAt = new Date().toISOString();
writeFileSync(outputFile, `${JSON.stringify({ generatedAt, songs: completeReports, flagCounts }, null, 2)}\n`, "utf8");
const publicFeatures = {
  version: 1,
  generatedAt,
  notes: "Derived waveform measurements only. Regenerate after replacing, trimming, or retiming hosted audio.",
  songs: completeReports.map((song) => ({
    id: song.id,
    firstSoundMs: song.firstSoundMs,
    firstAudibleMs: song.firstAudibleMs,
    firstStrongMs: song.firstStrongMs,
    firstMusicalMs: song.firstMusicalMs,
    recommendedPlayableMs: song.recommendedPlayableMs,
    first2SecondsDb: song.first2SecondsDb,
    seconds8To15Db: song.seconds8To15Db,
  })),
};
writeFileSync(publicFeaturesFile, `${JSON.stringify(publicFeatures, null, 2)}\n`, "utf8");
console.log(`\nAudited ${reports.length} hosted song(s); retained ${completeReports.length} total feature rows.`);
for (const [flag, count] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) console.log(`${flag}: ${count}`);
console.log(`Report: ${path.relative(root, outputFile)}`);
