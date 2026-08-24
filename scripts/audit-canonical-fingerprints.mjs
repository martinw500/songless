import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const metadataDirectory = path.join(root, "data", "itunes-track-metadata.local");
const previewDirectory = path.join(root, "data", "itunes-previews.local");
const deezerMetadataDirectory = path.join(root, "data", "deezer-track-metadata.local");
const deezerPreviewDirectory = path.join(root, "data", "deezer-track-previews.local");
const preparedDirectory = path.join(root, "private-media", "r2", "full");
const reportFile = path.join(root, "data", "canonical-fingerprint-audit.local.json");
const refresh = process.argv.includes("--refresh");
const restart = process.argv.includes("--restart");
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

const ffmpeg = findTool("ffmpeg");
mkdirSync(previewDirectory, { recursive: true });
mkdirSync(deezerPreviewDirectory, { recursive: true });

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsPhrase(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

function metadataMatchesCandidate(candidate, metadata) {
  const trackCredits = normalize(`${metadata.trackName ?? ""} ${metadata.artistName ?? ""} ${(metadata.contributors ?? []).join(" ")}`);
  const titles = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const title = normalize(metadata.trackName ?? "");
  return titles.some((option) => containsPhrase(title, option) || containsPhrase(option, title))
    && candidate.primaryArtists.map(normalize).every((artist) => containsPhrase(trackCredits, artist));
}

function fingerprint(file) {
  const raw = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", file, "-vn",
    "-f", "chromaprint", "-fp_format", "raw", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  const values = [];
  for (let offset = 0; offset + 4 <= raw.length; offset += 4) values.push(raw.readUInt32LE(offset));
  return values;
}

function popcount32(value) {
  let bits = value >>> 0;
  bits -= (bits >>> 1) & 0x55555555;
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function bestFingerprintMatch(full, preview) {
  // Drop a few boundary hashes because different containers can shift the
  // first/last Chromaprint windows while the recording itself is identical.
  const boundary = preview.length >= 40 ? 4 : 0;
  const needle = preview.slice(boundary, preview.length - boundary);
  if (needle.length < 12 || full.length < needle.length) return null;
  let best = null;
  for (let offset = 0; offset <= full.length - needle.length; offset += 1) {
    let differingBits = 0;
    for (let index = 0; index < needle.length; index += 1) {
      differingBits += popcount32(full[offset + index] ^ needle[index]);
    }
    const distance = differingBits / (needle.length * 32);
    if (!best || distance < best.distance) best = { offset, distance, comparedHashes: needle.length };
  }
  return best;
}

async function ensurePreview(id, previewUrl, directory = previewDirectory, extension = ".m4a") {
  const target = path.join(directory, `${id}${extension}`);
  if (existsSync(target) && !refresh) return target;
  const response = await fetch(previewUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`preview download returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 10_000) throw new Error(`preview download was unexpectedly small (${bytes.length} bytes)`);
  writeFileSync(target, bytes);
  return target;
}

const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs;
let report = !restart && existsSync(reportFile)
  ? JSON.parse(readFileSync(reportFile, "utf8"))
  : { generatedAt: new Date().toISOString(), songs: [], counts: {} };
if (selectedIds.size > 0) report.songs = report.songs.filter((song) => !selectedIds.has(song.id));
report.generatedAt = new Date().toISOString();
function saveReport() {
  report.counts = {};
  for (const song of report.songs) report.counts[song.status] = (report.counts[song.status] ?? 0) + 1;
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
saveReport();
const completedIds = new Set(report.songs.map((song) => song.id));
let processed = 0;
for (const candidate of candidates) {
  if (selectedIds.size > 0 && !selectedIds.has(candidate.id)) continue;
  if (completedIds.has(candidate.id)) continue;
  if (processed >= limit) break;
  const metadataFile = path.join(metadataDirectory, `${candidate.id}.json`);
  const deezerMetadataFile = path.join(deezerMetadataDirectory, `${candidate.id}.json`);
  const fullFile = path.join(preparedDirectory, `${candidate.id}.mp3`);
  if (!existsSync(fullFile)) continue;
  const itunesMetadata = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, "utf8")) : null;
  const deezerRaw = existsSync(deezerMetadataFile) ? JSON.parse(readFileSync(deezerMetadataFile, "utf8")) : null;
  const deezerMetadata = deezerRaw?.status === "matched" ? {
    durationSeconds: deezerRaw.durationSeconds,
    trackName: deezerRaw.trackName,
    artistName: deezerRaw.artistName,
    contributors: deezerRaw.contributors ?? [],
    collectionName: deezerRaw.albumName ?? null,
    previewUrl: deezerRaw.previewUrl,
    creditEvidence: deezerRaw.creditEvidence ?? null,
  } : null;
  const spotifyDurationSeconds = Number(candidate.spotifyDurationMs) / 1000;
  const hasSpotifyDuration = candidate.spotifyMetadataStatus === "verified_public_page"
    && Number.isFinite(spotifyDurationSeconds) && spotifyDurationSeconds > 0;
  const itunesMatches = itunesMetadata?.previewUrl && metadataMatchesCandidate(candidate, itunesMetadata);
  const itunesConflict = itunesMatches && hasSpotifyDuration
    && Math.abs(spotifyDurationSeconds - itunesMetadata.durationSeconds) > 2.5;
  const deezerSpotifyCorroborated = deezerMetadata?.creditEvidence === "verified_spotify_public_page"
    && hasSpotifyDuration
    && Math.abs(spotifyDurationSeconds - deezerMetadata.durationSeconds) <= 2;
  const deezerMatches = deezerMetadata?.previewUrl
    && (metadataMatchesCandidate(candidate, deezerMetadata) || deezerSpotifyCorroborated)
    && (!hasSpotifyDuration || Math.abs(spotifyDurationSeconds - deezerMetadata.durationSeconds) <= 5);
  const metadata = itunesMatches && !itunesConflict ? itunesMetadata : deezerMatches ? deezerMetadata : null;
  const referenceSource = metadata === itunesMetadata ? "itunes" : metadata === deezerMetadata ? "deezer" : null;
  if (!metadata) {
    if (itunesMetadata?.previewUrl && !itunesMatches) {
      report.songs.push({ id: candidate.id, status: "reference_incomplete_credits" });
      completedIds.add(candidate.id);
      saveReport();
    } else if (itunesConflict) {
      report.songs.push({
        id: candidate.id,
        status: "reference_conflict",
        spotifyDurationSeconds,
        itunesDurationSeconds: itunesMetadata.durationSeconds,
      });
      completedIds.add(candidate.id);
      saveReport();
    }
    continue;
  }
  processed += 1;
  try {
    const previewFile = await ensurePreview(
      candidate.id,
      metadata.previewUrl,
      referenceSource === "deezer" ? deezerPreviewDirectory : previewDirectory,
      referenceSource === "deezer" ? ".mp3" : ".m4a",
    );
    const contentVersion = createHash("sha256").update(readFileSync(fullFile)).digest("hex").slice(0, 12);
    const fullFingerprint = fingerprint(fullFile);
    const previewFingerprint = fingerprint(previewFile);
    const match = bestFingerprintMatch(fullFingerprint, previewFingerprint);
    const distance = match?.distance ?? null;
    const status = distance === null ? "insufficient_fingerprint"
      : distance <= 0.18 ? "canonical_match"
        : distance <= 0.28 ? "probable_match"
          : "recording_mismatch";
    const row = {
      id: candidate.id,
      status,
      contentVersion,
      distance: distance === null ? null : Number(distance.toFixed(4)),
      fullHashes: fullFingerprint.length,
      previewHashes: previewFingerprint.length,
      matchedOffsetHashes: match?.offset ?? null,
      comparedHashes: match?.comparedHashes ?? 0,
      canonicalTrack: metadata.trackName ?? null,
      canonicalArtist: metadata.artistName ?? null,
      canonicalAlbum: metadata.collectionName ?? null,
      referenceSource,
    };
    report.songs.push(row);
    completedIds.add(candidate.id);
    saveReport();
    if (verbose || status !== "canonical_match") {
      console.log(`${status.toUpperCase()} ${candidate.id}: distance=${row.distance}`);
    }
  } catch (error) {
    report.songs.push({ id: candidate.id, status: "error", error: error.message });
    completedIds.add(candidate.id);
    saveReport();
    console.error(`ERROR ${candidate.id}: ${error.message}`);
  }
}

saveReport();
console.log(`Fingerprint audit: ${report.songs.length} song(s); ${Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join(", ")}.`);
console.log(`Report: ${path.relative(root, reportFile)}`);
