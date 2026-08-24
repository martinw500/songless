import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const sourceFile = path.join(root, "data", "song-download-sources.local.json");
const metadataDirectory = path.join(root, "data", "itunes-track-metadata.local");
const previewDirectory = path.join(root, "data", "itunes-previews.local");
const deezerMetadataDirectory = path.join(root, "data", "deezer-track-metadata.local");
const deezerPreviewDirectory = path.join(root, "data", "deezer-track-previews.local");
const searchDirectory = path.join(root, "data", "studio-source-search.local");
const cacheDirectory = path.join(root, "private-media", "source-candidate-audit.local");
const reportFile = path.join(root, "data", "source-candidate-fingerprint-audit.local.json");
const apply = process.argv.includes("--apply");
const selectedIds = new Set(
  (process.argv.find((value) => value.startsWith("--id="))?.split("=")[1] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);
const maxCandidates = Math.max(1, Math.min(20, Number(
  process.argv.find((value) => value.startsWith("--max-candidates="))?.split("=")[1] ?? 10,
)));
if (selectedIds.size === 0) throw new Error("Pass one or more exact candidate IDs with --id=<comma-separated-ids>.");

function findTool(name) {
  try {
    const located = execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/u).find(Boolean);
    if (located) return located;
  } catch {
    // Fall through to the WinGet package search.
  }
  const packages = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  if (existsSync(packages)) {
    const stack = [packages];
    while (stack.length > 0) {
      const directory = stack.pop();
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(entryPath);
        else if (entry.name.toLowerCase() === `${name}.exe`) return entryPath;
      }
    }
  }
  throw new Error(`${name} was not found.`);
}

const ffmpeg = findTool("ffmpeg");
const ytDlp = findTool("yt-dlp");
mkdirSync(cacheDirectory, { recursive: true });

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsPhrase(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

const altered = /\b(live|concert|acoustic|stripped|remix|mix|dub|medley|sped|slowed|reverb|nightcore|cover|karaoke|instrumental|clean|radio (?:edit|version)|official (?:music )?video|extended|re recorded|rerecorded|remake|mashup|parody|demo|tribute|made famous|fanmade|workout|8d|12d|432hz|528hz)\b/iu;

function normalizeArtist(value = "") {
  return normalize(value).replace(/^(?:the|ms)\s+/u, "");
}

function eligible(candidate, entry, metadata) {
  const canonicalDuration = metadata.durationSeconds;
  if (!entry?.id || !Number.isFinite(entry.duration) || Math.abs(entry.duration - canonicalDuration) > 5) return false;
  const title = normalize(entry.title ?? "");
  const channel = normalize(entry.channel ?? entry.uploader ?? "");
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const matchedTitle = titleOptions.find((option) => containsPhrase(title, option));
  if (!matchedTitle) return false;
  const credits = `${title} ${channel}`;
  const compactCredits = credits.replace(/\s+/gu, "");
  const completeCredits = candidate.primaryArtists.map(normalize).every((artist) => (
    containsPhrase(credits, artist) || compactCredits.includes(artist.replace(/\s+/gu, ""))
  ));
  const normalizedCredits = normalizeArtist(credits);
  const singleArtistAlias = candidate.primaryArtists.length === 1
    && containsPhrase(normalizedCredits, normalizeArtist(candidate.primaryArtists[0]));
  const spotifyDurationSeconds = Number(candidate.spotifyDurationMs) / 1000;
  const spotifyCorroborated = candidate.spotifyMetadataStatus === "verified_public_page"
    && Number.isFinite(spotifyDurationSeconds)
    && Math.abs(spotifyDurationSeconds - canonicalDuration) <= 2
    && (metadata.creditEvidence === "verified_spotify_public_page"
      || Math.abs(Number(metadata.durationSeconds) - spotifyDurationSeconds) <= 2);
  if (!completeCredits && !singleArtistAlias && !spotifyCorroborated) return false;
  let versionText = title.replace(matchedTitle, " ");
  for (const artist of candidate.primaryArtists.map(normalize)) versionText = versionText.replaceAll(artist, " ");
  return !altered.test(versionText);
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

function bestDistance(full, preview) {
  const boundary = preview.length >= 40 ? 4 : 0;
  const needle = preview.slice(boundary, preview.length - boundary);
  if (needle.length < 12 || full.length < needle.length) return null;
  let best = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset <= full.length - needle.length; offset += 1) {
    let bits = 0;
    for (let index = 0; index < needle.length; index += 1) bits += popcount32(full[offset + index] ^ needle[index]);
    best = Math.min(best, bits / (needle.length * 32));
  }
  return best;
}

function download(entry, directory) {
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${entry.id}.webm`);
  if (existsSync(target)) return target;
  const url = entry.url?.startsWith("http") ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`;
  const result = spawnSync(ytDlp, ["--no-playlist", "--no-warnings", "-f", "bestaudio", "-o", target, url], {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `yt-dlp exited ${result.status}`);
  return target;
}

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const candidates = new Map(candidateRoot.songs.map((song) => [song.id, song]));
const sourceRoot = JSON.parse(readFileSync(sourceFile, "utf8"));
const sourceById = new Map(sourceRoot.songs.map((song) => [song.id, song]));
const report = { generatedAt: new Date().toISOString(), songs: [] };

for (const id of selectedIds) {
  const candidate = candidates.get(id);
  if (!candidate) throw new Error(`Unknown candidate: ${id}`);
  const itunesMetadataFile = path.join(metadataDirectory, `${id}.json`);
  const itunesPreviewFile = path.join(previewDirectory, `${id}.m4a`);
  const deezerMetadataFile = path.join(deezerMetadataDirectory, `${id}.json`);
  const deezerPreviewFile = path.join(deezerPreviewDirectory, `${id}.mp3`);
  const searchFile = path.join(searchDirectory, `${id}.json`);
  const itunesMetadata = existsSync(itunesMetadataFile) ? JSON.parse(readFileSync(itunesMetadataFile, "utf8")) : null;
  const deezerMetadata = existsSync(deezerMetadataFile) ? JSON.parse(readFileSync(deezerMetadataFile, "utf8")) : null;
  const useDeezer = deezerMetadata?.status === "matched"
    && deezerMetadata.previewUrl && existsSync(deezerPreviewFile);
  const useItunes = !useDeezer && Boolean(itunesMetadata?.previewUrl && existsSync(itunesPreviewFile));
  const metadata = useItunes ? itunesMetadata : useDeezer ? deezerMetadata : null;
  const previewFile = useItunes ? itunesPreviewFile : useDeezer ? deezerPreviewFile : null;
  if (!metadata || !previewFile || !existsSync(searchFile)) {
    report.songs.push({ id, status: "missing-cache" });
    continue;
  }
  const search = JSON.parse(readFileSync(searchFile, "utf8"));
  const entries = (search.entries ?? []).filter((entry) => eligible(candidate, entry, metadata)).slice(0, maxCandidates);
  const previewFingerprint = fingerprint(previewFile);
  const results = [];
  for (const entry of entries) {
    try {
      const file = download(entry, path.join(cacheDirectory, id));
      const distance = bestDistance(fingerprint(file), previewFingerprint);
      results.push({
        videoId: entry.id,
        url: entry.url?.startsWith("http") ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
        title: entry.title,
        channel: entry.channel ?? entry.uploader ?? null,
        channelId: entry.channel_id ?? entry.uploader_id ?? null,
        channelVerified: Boolean(entry.channel_is_verified),
        durationSeconds: entry.duration,
        distance: distance === null ? null : Number(distance.toFixed(4)),
        provenanceScore: (entry.channel_is_verified ? 100 : 0)
          + (candidate.primaryArtists.some((artist) => (
            normalize(entry.channel ?? entry.uploader ?? "").replace(/\s+/gu, "").includes(normalize(artist).replace(/\s+/gu, ""))
          )) ? 300 : 0),
      });
    } catch (error) {
      results.push({ videoId: entry.id, title: entry.title, status: "error", error: error.message });
    }
  }
  results.sort((left, right) => {
    const leftCanonical = left.distance !== null && left.distance <= 0.18;
    const rightCanonical = right.distance !== null && right.distance <= 0.18;
    if (leftCanonical !== rightCanonical) return rightCanonical - leftCanonical;
    if (leftCanonical && left.provenanceScore !== right.provenanceScore) return right.provenanceScore - left.provenanceScore;
    if (leftCanonical) {
      const leftDurationDifference = Math.abs(left.durationSeconds - metadata.durationSeconds);
      const rightDurationDifference = Math.abs(right.durationSeconds - metadata.durationSeconds);
      if (leftDurationDifference !== rightDurationDifference) return leftDurationDifference - rightDurationDifference;
    }
    return (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY);
  });
  const best = results[0];
  const status = best?.distance <= 0.18 ? "canonical_match" : best ? "no-canonical-match" : "no-eligible-candidate";
  report.songs.push({
    id,
    status,
    referenceSource: useItunes ? "itunes" : "deezer",
    canonicalDurationSeconds: metadata.durationSeconds,
    best: best ?? null,
    results,
  });
  console.log(`${status.toUpperCase()} ${id}${best ? `: ${best.distance} — ${best.title} — ${best.channel}` : ""}`);
  if (apply && status === "canonical_match") {
    let source = sourceById.get(id);
    if (!source) {
      source = { id, title: candidate.title, artist: candidate.artist, url: "" };
      sourceRoot.songs.push(source);
      sourceById.set(id, source);
    }
    source.url = best.url;
    source.youtube = {
      videoId: best.videoId,
      title: best.title,
      channel: best.channel,
      channelId: best.channelId,
      durationSeconds: best.durationSeconds,
      channelVerified: best.channelVerified,
      fingerprintDistance: best.distance,
      resolutionMethod: "canonical-acoustic-fingerprint",
      resolvedAt: new Date().toISOString(),
    };
  }
}

if (apply) writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Report: ${path.relative(root, reportFile)}`);
