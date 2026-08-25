import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clueWindowIsAudible,
  clueWindowMs,
  clueWindowSilent,
  configuredStartMs as resolveConfiguredStartMs,
  digitalSilenceDb,
  evaluateClueWindow,
  gateMinAudibleSubWindows,
  gateOffsetDb,
  leadSilenceMs,
  mp3FrameToleranceMs,
  onsetOffsetDb,
  onsetPreferenceWindowMs,
  subWindowCount,
  subWindowMs,
} from "./media-start-normalization.mjs";

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

// 44.1 kHz with a 10 ms hop is the coarsest analysis that can still resolve the
// 0.01s stage in stageOptions. The previous 8 kHz / 50 ms envelope averaged
// silence together with the onset transient and reported starts inside dead air.
const SAMPLE_RATE = 44100;
const FINE_MS = 10;
const FINE_SAMPLES = (SAMPLE_RATE * FINE_MS) / 1000;
const COARSE_GROUP = 5;

function decode(file, seconds = 35) {
  const buffer = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", file, "-t", String(seconds),
    "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 96 * 1024 * 1024 });
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
}

function durationMs(file) {
  const value = execFileSync(ffprobe, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { encoding: "utf8" }).trim();
  return Math.round(Number(value) * 1000);
}

const FRAME_SECONDS = COARSE_GROUP * FINE_MS / 1000;

function toDb(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

function envelope(samples) {
  const frames = [];
  for (let offset = 0; offset + FINE_SAMPLES <= samples.length; offset += FINE_SAMPLES) {
    let sum = 0;
    let peak = 0;
    for (let index = offset; index < offset + FINE_SAMPLES; index += 1) {
      const absolute = Math.abs(samples[index]);
      sum += samples[index] * samples[index];
      peak = Math.max(peak, absolute);
    }
    const rms = Math.sqrt(sum / FINE_SAMPLES);
    frames.push({ rms, db: toDb(rms), peak });
  }
  return frames;
}

// Energy averaging, not dB averaging: a window is as loud as the power it
// carries, so one loud 10 ms frame must be able to carry a quiet neighbour.
function windowDb(frames, startIndex, frameCount) {
  const end = Math.min(frames.length, startIndex + frameCount);
  const start = Math.max(0, startIndex);
  if (end <= start) return null;
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += frames[index].rms * frames[index].rms;
  return toDb(Math.sqrt(sum / (end - start)));
}

// The 50 ms view the alignment correlation and the legacy medians expect.
function coarsen(frames) {
  const coarse = [];
  for (let index = 0; index + COARSE_GROUP <= frames.length; index += COARSE_GROUP) {
    let sum = 0;
    let peak = 0;
    for (let cursor = index; cursor < index + COARSE_GROUP; cursor += 1) {
      sum += frames[cursor].rms * frames[cursor].rms;
      peak = Math.max(peak, frames[cursor].peak);
    }
    const rms = Math.sqrt(sum / COARSE_GROUP);
    coarse.push({ rms, db: toDb(rms), peak });
  }
  return coarse;
}

// Returns the frame that actually crosses the threshold. The previous version
// returned the start of a 2-of-3 window, which routinely pointed at a silent
// frame and is the direct cause of clues that open on dead air.
function firstSustained(frames, thresholdDb, sustainMs = 150, requiredRatio = 2 / 3) {
  const windowFrames = Math.max(1, Math.round(sustainMs / FINE_MS));
  for (let index = 0; index + windowFrames <= frames.length; index += 1) {
    if (frames[index].db < thresholdDb) continue;
    let audible = 0;
    for (let cursor = 0; cursor < windowFrames; cursor += 1) {
      if (frames[index + cursor].db >= thresholdDb) audible += 1;
    }
    if (audible / windowFrames >= requiredRatio) return index * FINE_MS;
  }
  return null;
}

function firstMostlyAudibleWindow(frames, thresholdDb = -45, windowMs = 1000, requiredRatio = 0.65) {
  const windowFrames = Math.round(windowMs / FINE_MS);
  for (let index = 0; index + windowFrames <= frames.length; index += 1) {
    let audible = 0;
    for (let cursor = 0; cursor < windowFrames; cursor += 1) {
      if (frames[index + cursor].db >= thresholdDb) audible += 1;
    }
    if (audible / windowFrames >= requiredRatio) return index * FINE_MS;
  }
  return null;
}

function median(values) {
  if (values.length === 0) return -160;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function rangeMedian(frames, startSeconds, endSeconds) {
  const start = Math.max(0, Math.floor(startSeconds * 1000 / FINE_MS));
  const end = Math.min(frames.length, Math.ceil(endSeconds * 1000 / FINE_MS));
  return median(frames.slice(start, end).map((frame) => frame.db));
}

function firstPlayableWindow(frames, clueGainDb, windowSeconds = 2) {
  const windowFrames = Math.round(windowSeconds * 1000 / FINE_MS);
  const targetRawDb = -38 - clueGainDb;
  for (let index = 0; index + windowFrames <= frames.length; index += 1) {
    const level = median(frames.slice(index, index + windowFrames).map((frame) => frame.db));
    if (level >= targetRawDb) return index * FINE_MS;
  }
  return null;
}

// The song's own established loudness. Every audibility threshold is measured
// against this so a -60 dB analogue noise floor and a -180 dB digital zero
// both classify correctly without per-song tuning.
function bodyLevelDb(frames) {
  const preferred = rangeMedian(frames, 5, 20);
  if (Number.isFinite(preferred) && preferred > -100) return preferred;
  const fallback = rangeMedian(frames, 1, Math.max(2, frames.length * FINE_MS / 1000));
  return Number.isFinite(fallback) ? fallback : null;
}

// The five 20 ms sub-windows a 100 ms clue beginning at startMs is made of.
function clueSubWindowDbs(frames, startMs) {
  const index = Math.round(startMs / FINE_MS);
  const subFrames = subWindowMs / FINE_MS;
  const values = [];
  for (let slot = 0; slot < subWindowCount; slot += 1) {
    const level = windowDb(frames, index + slot * subFrames, subFrames);
    if (level === null) return values;
    values.push(level);
  }
  return values;
}

function searchOnset(frames, bodyDb, clueGainDb, offsetDb, required, fromMs = 0, toMs = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(bodyDb)) return null;
  const limit = Math.min(toMs, frames.length * FINE_MS - clueWindowMs);
  for (let startMs = Math.max(0, fromMs); startMs <= limit; startMs += FINE_MS) {
    const subWindowDbs = clueSubWindowDbs(frames, startMs);
    if (subWindowDbs.length < subWindowCount) break;
    if (!clueWindowIsAudible(subWindowDbs, bodyDb, clueGainDb, offsetDb, required)) continue;
    if (leadHasDigitalSilence(frames, startMs)) continue;
    return startMs;
  }
  return null;
}

// Defining the onset by the same measurement the gate uses guarantees that a
// corrected start passes, instead of chasing a separate notion of "loud".
// The search begins at the configured start so that a deliberately late start,
// chosen to open on a hook, is moved forward to audible audio rather than
// unwound back to the top of the track.
// The strict threshold is preferred only when it arrives soon after the clue
// first sounds continuous; otherwise the song has a deliberately quiet intro
// and skipping to its loud section would discard real music.
function musicOnsetMs(frames, bodyDb, clueGainDb, fromMs) {
  const gateOnset = searchOnset(frames, bodyDb, clueGainDb, gateOffsetDb, gateMinAudibleSubWindows, fromMs);
  if (gateOnset === null) return null;
  const strictOnset = searchOnset(
    frames, bodyDb, clueGainDb, onsetOffsetDb, subWindowCount,
    gateOnset, gateOnset + onsetPreferenceWindowMs,
  );
  return strictOnset ?? gateOnset;
}

// Digital zeros at the very front of a clue are always wrong, however the rest
// of the window measures.
function leadHasDigitalSilence(frames, startMs) {
  const index = Math.round(startMs / FINE_MS);
  const end = Math.min(frames.length, index + leadSilenceMs / FINE_MS);
  for (let cursor = Math.max(0, index); cursor < end; cursor += 1) {
    if (frames[cursor].db < digitalSilenceDb) return true;
  }
  return false;
}

// Measures the exact audio the player hears when a clue begins at startMs.
function clueWindowMeasurements(frames, startMs) {
  const index = Math.round(startMs / FINE_MS);
  if (index >= frames.length) return null;
  const windowFrames = clueWindowMs / FINE_MS;
  const earlyIndex = Math.max(0, Math.round((startMs - mp3FrameToleranceMs) / FINE_MS));
  return {
    subWindowDbs: clueSubWindowDbs(frames, startMs),
    clueFirst100Db: windowDb(frames, index, windowFrames),
    earlySeekMeanDb: windowDb(frames, earlyIndex, windowFrames),
    leadHasDigitalSilence: leadHasDigitalSilence(frames, startMs),
  };
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
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
  const fullFile = path.join(root, "private-media", "r2", "full", `${song.id}.mp3`);
  const clueFile = path.join(root, "private-media", "r2", "clues", `${song.id}.mp3`);
  const hasHosted = Boolean(song.media?.hostedFullUrl && song.media?.hostedClueUrl);
  const hasPrepared = existsSync(fullFile) && existsSync(clueFile);
  if (!hasHosted && !(selectedIds.size > 0 && hasPrepared)) continue;
  if (processed >= limit) break;
  processed += 1;
  const source = sourceById.get(song.id);
  const flags = [];
  if (!hasPrepared) {
    reports.push({ id: song.id, title: song.title, artist: song.artist, flags: ["missing-local-media"] });
    continue;
  }
  try {
    const fullFrames = envelope(decode(fullFile));
    const clueFrames = envelope(decode(clueFile));
    const configuredStartMs = resolveConfiguredStartMs(song);
    const clueGainDb = song.clueGainDb ?? 0;
    const bodyDb = bodyLevelDb(fullFrames);
    const firstSoundMs = firstSustained(fullFrames, -52);
    const firstAudibleMs = firstSustained(fullFrames, -42);
    const firstStrongMs = firstSustained(fullFrames, -32);
    const firstMusicalMs = firstMostlyAudibleWindow(fullFrames);
    const introDb = rangeMedian(fullFrames, configuredStartMs / 1000, configuredStartMs / 1000 + 2);
    const laterDb = rangeMedian(fullFrames, configuredStartMs / 1000 + 8, configuredStartMs / 1000 + 15);
    const effectiveIntroDb = introDb + clueGainDb;
    const recommendedPlayableMs = firstPlayableWindow(fullFrames, clueGainDb);
    const aligned = alignment(coarsen(fullFrames), coarsen(clueFrames));
    const actualDurationMs = durationMs(fullFile);
    const kind = sourceKind(source, song);

    // The gate reads the clue asset the browser actually requests for short
    // stages, so encoder priming and trim drift are included in the verdict.
    const measured = clueWindowMeasurements(clueFrames, configuredStartMs);
    const verdict = measured
      ? evaluateClueWindow({ bodyDb, clueGainDb, ...measured })
      : { status: clueWindowSilent, reasons: ["clue-window-past-end"], audibleSubWindows: null };
    const onsetMs = verdict.status === clueWindowSilent
      ? musicOnsetMs(clueFrames, bodyDb, clueGainDb, configuredStartMs)
      : configuredStartMs;
    if (verdict.status === clueWindowSilent) {
      flags.push(clueWindowSilent);
      // No forward correction is available, so this one needs a person.
      if (!Number.isInteger(onsetMs) || onsetMs <= configuredStartMs) flags.push("clue-window-needs-review");
    }

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
      bodyDb: round1(bodyDb),
      musicOnsetMs: onsetMs,
      clueWindowStartMs: configuredStartMs,
      clueWindowStatus: verdict.status,
      clueWindowReasons: verdict.reasons,
      clueAudibleSubWindows: verdict.audibleSubWindows,
      clueSubWindowDbs: (measured?.subWindowDbs ?? []).map(round1),
      clueFirst100Db: round1(measured?.clueFirst100Db),
      clueEarlySeekDb: round1(measured?.earlySeekMeanDb),
      firstSoundMs,
      firstAudibleMs,
      firstStrongMs,
      firstMusicalMs,
      first2SecondsDb: round1(introDb),
      clueGainDb,
      effectiveFirst2SecondsDb: round1(effectiveIntroDb),
      recommendedPlayableMs,
      seconds8To15Db: round1(laterDb),
      clueFullAlignment: aligned,
      actualDurationMs,
      catalogDurationMs: song.media.hostedDurationMs,
      sourceKind: kind,
      sourceTitle: source?.youtube?.title ?? null,
      sourceChannel: source?.youtube?.channel ?? null,
      flags,
    });
    if (flags.length > 0 || selectedIds.size > 0 || verbose) {
      console.log(`${flags.length ? "FLAG" : "PASS"} ${song.id}${flags.length ? `: ${flags.join(", ")}` : ""}`
        + (verdict.status === clueWindowSilent ? ` [${verdict.reasons.join("/")}; start=${configuredStartMs}ms onset=${onsetMs ?? "?"}ms body=${round1(bodyDb)}dB]` : ""));
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
    bodyDb: song.bodyDb ?? null,
    musicOnsetMs: song.musicOnsetMs ?? null,
    clueWindowStartMs: song.clueWindowStartMs ?? null,
    clueWindowStatus: song.clueWindowStatus ?? null,
    clueWindowReasons: song.clueWindowReasons ?? null,
    clueAudibleSubWindows: song.clueAudibleSubWindows ?? null,
    clueFirst100Db: song.clueFirst100Db ?? null,
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
const silentCount = completeReports.filter((song) => song.clueWindowStatus === clueWindowSilent).length;
console.log(`Clue-window gate: ${completeReports.length - silentCount} pass, ${silentCount} silent.`);
console.log(`Report: ${path.relative(root, outputFile)}`);
