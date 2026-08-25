import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectionFile = path.join(root, "data", "billion-media-selection.local.json");
const candidateFile = path.join(root, "data", "song-candidates.json");
const sourceFile = path.join(root, "data", "song-download-sources.local.json");
const sourceDirectory = path.join(root, "private-media", "source");
const reportFile = path.join(root, "data", "billion-source-duration-audit.local.json");
const audioExtension = /\.(m4a|mp3|opus|ogg|wav|webm|flac|aac|mp4)$/i;
const verbose = process.argv.includes("--verbose");
const selectedIds = new Set(
  (process.argv.find((value) => value.startsWith("--id="))?.split("=")[1] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);

function findTool(name) {
  const explicitDirectory = process.env.FFMPEG_DIR?.trim();
  if (explicitDirectory) {
    const explicit = path.join(explicitDirectory, `${name}.exe`);
    if (existsSync(explicit)) return explicit;
  }
  try {
    const located = execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/u).find(Boolean);
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

const ffprobe = findTool("ffprobe");
const selection = JSON.parse(readFileSync(selectionFile, "utf8"));
const candidates = new Map(JSON.parse(readFileSync(candidateFile, "utf8")).songs.map((song) => [song.id, song]));
const sources = new Map(JSON.parse(readFileSync(sourceFile, "utf8")).songs.map((song) => [song.id, song]));
const sourceFiles = existsSync(sourceDirectory)
  ? readdirSync(sourceDirectory).filter((name) => audioExtension.test(name))
  : [];

function findSourceFile(id) {
  return sourceFiles.find((name) => name.startsWith(`${id}.`) && audioExtension.test(name)) ?? null;
}

function probeDurationSeconds(file) {
  const text = execFileSync(ffprobe, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { encoding: "utf8" }).trim();
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid probe duration: ${text}`);
  return value;
}

function withinTolerance(left, right, toleranceSeconds = 3) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= toleranceSeconds;
}

const songs = [];
for (const row of selection.selected) {
  if (selectedIds.size > 0 && !selectedIds.has(row.id)) continue;
  const candidate = candidates.get(row.id);
  const source = sources.get(row.id);
  const sourceName = findSourceFile(row.id);
  if (!sourceName) {
    songs.push({
      id: row.id,
      status: "missing_source",
      fingerprintRequired: Boolean(row.fingerprintRequired),
      sourceRank: row.sourceRank,
    });
    if (verbose) console.log(`MISSING_SOURCE ${row.id}`);
    continue;
  }
  const absolute = path.join(sourceDirectory, sourceName);
  let probedSeconds;
  try {
    probedSeconds = probeDurationSeconds(absolute);
  } catch (error) {
    songs.push({
      id: row.id,
      status: "probe_failed",
      sourceFile: sourceName,
      error: error.message,
      fingerprintRequired: Boolean(row.fingerprintRequired),
      sourceRank: row.sourceRank,
    });
    if (verbose) console.log(`PROBE_FAILED ${row.id}: ${error.message}`);
    continue;
  }

  const youtubeSeconds = Number(source?.youtube?.durationSeconds);
  const itunesSeconds = Number(candidate?.itunesDurationMs) / 1000;
  const spotifySeconds = Number(candidate?.spotifyDurationMs) / 1000;
  const hasItunes = Number.isFinite(itunesSeconds) && itunesSeconds > 0;
  const hasSpotify = Number.isFinite(spotifySeconds) && spotifySeconds > 0
    && candidate?.spotifyMetadataStatus === "verified_public_page";
  const hasYoutube = Number.isFinite(youtubeSeconds) && youtubeSeconds > 0;

  if (hasYoutube && !withinTolerance(probedSeconds, youtubeSeconds)) {
    songs.push({
      id: row.id,
      status: "youtube_mismatch",
      sourceFile: sourceName,
      probedSeconds: Number(probedSeconds.toFixed(3)),
      youtubeSeconds,
      differenceSeconds: Number((probedSeconds - youtubeSeconds).toFixed(3)),
      fingerprintRequired: Boolean(row.fingerprintRequired),
      sourceRank: row.sourceRank,
    });
    if (verbose) console.log(`YOUTUBE_MISMATCH ${row.id}: probe=${probedSeconds.toFixed(1)}s youtube=${youtubeSeconds}s`);
    continue;
  }

  if (hasItunes && !withinTolerance(probedSeconds, itunesSeconds)) {
    songs.push({
      id: row.id,
      status: "canonical_mismatch",
      sourceFile: sourceName,
      probedSeconds: Number(probedSeconds.toFixed(3)),
      itunesSeconds: Number(itunesSeconds.toFixed(3)),
      differenceSeconds: Number((probedSeconds - itunesSeconds).toFixed(3)),
      reference: "itunes",
      fingerprintRequired: Boolean(row.fingerprintRequired),
      sourceRank: row.sourceRank,
    });
    if (verbose) console.log(`CANONICAL_MISMATCH ${row.id}: probe=${probedSeconds.toFixed(1)}s itunes=${itunesSeconds.toFixed(1)}s`);
    continue;
  }

  if (hasSpotify && !withinTolerance(probedSeconds, spotifySeconds)) {
    songs.push({
      id: row.id,
      status: "canonical_mismatch",
      sourceFile: sourceName,
      probedSeconds: Number(probedSeconds.toFixed(3)),
      spotifySeconds: Number(spotifySeconds.toFixed(3)),
      differenceSeconds: Number((probedSeconds - spotifySeconds).toFixed(3)),
      reference: "spotify",
      fingerprintRequired: Boolean(row.fingerprintRequired),
      sourceRank: row.sourceRank,
    });
    if (verbose) console.log(`CANONICAL_MISMATCH ${row.id}: probe=${probedSeconds.toFixed(1)}s spotify=${spotifySeconds.toFixed(1)}s`);
    continue;
  }

  songs.push({
    id: row.id,
    status: "pass",
    sourceFile: sourceName,
    probedSeconds: Number(probedSeconds.toFixed(3)),
    youtubeSeconds: hasYoutube ? youtubeSeconds : null,
    itunesSeconds: hasItunes ? Number(itunesSeconds.toFixed(3)) : null,
    spotifySeconds: hasSpotify ? Number(spotifySeconds.toFixed(3)) : null,
    fingerprintRequired: Boolean(row.fingerprintRequired),
    sourceRank: row.sourceRank,
  });
  if (verbose) console.log(`PASS ${row.id}: ${probedSeconds.toFixed(1)}s`);
}

const counts = {};
for (const song of songs) counts[song.status] = (counts[song.status] ?? 0) + 1;
const report = {
  generatedAt: new Date().toISOString(),
  selectedCount: selection.selectedCount,
  auditedCount: songs.length,
  counts,
  songs,
};
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Duration audit: ${songs.length} song(s); ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")}.`);
console.log(`Report: ${path.relative(root, reportFile)}`);
console.log(`Passing: ${counts.pass ?? 0}`);
