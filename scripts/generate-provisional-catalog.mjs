import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScorer } from "./provisional-scoring.mjs";
import { playbackGainFromBodyDb } from "./media-start-normalization.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const longlistFile = path.join(root, "data", "song-longlist.json");
const introFeaturesFile = path.join(root, "data", "intro-audio-features.json");
const catalogFile = path.join(root, "public", "catalog.json");
const backupFile = path.join(root, "public", "catalog-demo-backup.json");

const dryRun = process.argv.includes("--dry-run");

// Back up current catalogue
if (!existsSync(backupFile)) {
  copyFileSync(catalogFile, backupFile);
  console.log(`Backed up demo catalogue to ${path.basename(backupFile)}.`);
} else {
  console.log(`Demo backup already exists at ${path.basename(backupFile)}.`);
}

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const songs = candidateRoot.songs.filter(
  (s) =>
    s.reviewStatus !== "rejected" &&
    s.media?.hostedClueUrl &&
    s.media?.hostedFullUrl &&
    Number.isInteger(s.media.hostedDurationMs)
);


const longlist = JSON.parse(readFileSync(longlistFile, "utf8"));
const introFeatures = existsSync(introFeaturesFile)
  ? JSON.parse(readFileSync(introFeaturesFile, "utf8"))
  : { songs: [] };
const featureById = new Map((introFeatures.songs ?? []).map((feature) => [feature.id, feature]));
const scoreSong = createScorer(longlist, introFeatures);
const withEase = songs.map((song) => ({ song, ...scoreSong(song) }));

// Sort by ease descending
withEase.sort((a, b) => b.easeScore - a.easeScore || a.song.title.localeCompare(b.song.title));

const catalog = withEase.map((entry, index) => {
  const s = entry.song;
  const artwork = s.media.artworkUrl || undefined;
  const playbackGainDb = playbackGainFromBodyDb(featureById.get(s.id)?.bodyDb);

  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    aliases: s.aliases,
    artistAliases: s.artistAliases,
    ...(s.album ? { album: s.album } : {}),
    ...(s.spotifyUrl ? { spotifyUrl: s.spotifyUrl } : {}),
    releaseYear: s.releaseYear,
    genres: s.genres,
    difficulty: entry.difficulty,
    familiarity: s.familiarity,
    recognitionScore: entry.recognitionScore,
    audienceFamiliarityScore: entry.audienceFamiliarityScore,
    streamReachScore: entry.streamReachScore,
    genZRelevanceScore: entry.genZRelevanceScore,
    longevityScore: entry.longevityScore,
    introRecognition: entry.introRecognition,
    startAtMs: s.startAtMs ?? s.media?.onsetPadMs ?? 30,
    ...(s.clueGainDb != null ? { clueGainDb: s.clueGainDb } : {}),
    ...(playbackGainDb > 0 ? { playbackGainDb } : {}),
    ...(s.hookStartMs != null ? { hookStartMs: s.hookStartMs } : {}),
    ...(artwork ? { artwork } : {}),
    audio: {
      kind: "hosted",
      clueSrc: s.media.hostedClueUrl,
      fullSrc: s.media.hostedFullUrl,
      durationMs: s.media.hostedDurationMs,
    },
    _provisional: true,
    _provisionalMethod: entry.introScoreMethod,
    _easeScore: entry.easeScore,
    _rank: index + 1,
  };
});

// Count per difficulty
const counts = {};
for (const entry of catalog) counts[entry.difficulty] = (counts[entry.difficulty] || 0) + 1;

console.log("\n=== Provisional Catalogue ===");
console.log(`Total songs: ${songs.length}`);
console.log(`Reviewed method: 45% intro + 35% reach + 15% Gen-Z/current + 5% longevity`);
console.log(`Provisional method: 10% audibility + 50% reach + 20% audience familiarity + 15% Gen-Z/current + 5% longevity`);
console.log(`  easy      : ${counts.easy}`);
console.log(`  medium    : ${counts.medium}`);
console.log(`  hard      : ${counts.hard}`);
console.log(`  expert    : ${counts.expert}`);
console.log(`  impossible: ${counts.impossible}`);

const withIntro = withEase.filter((e) => e.introScoreMethod === "reviewed").length;
const withoutIntro = withEase.length - withIntro;
console.log(`\nIntro reviewed: ${withIntro}`);
console.log(`Waveform audibility proxies (provisional): ${withoutIntro}`);
console.log(`\nEase score range: ${withEase[withEase.length - 1].easeScore} – ${withEase[0].easeScore}`);

// (Band boundaries removed because we now use absolute thresholds)

if (dryRun) {
  console.log("\n[DRY RUN] No files written.");
} else {
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(`\nWrote provisional catalogue to ${path.basename(catalogFile)}.`);
  console.log("⚠ This is a PROVISIONAL catalogue for testing only.");
  console.log("  Unreviewed intro scores are waveform audibility proxies and must be replaced by blind identification reviews.");
  console.log("  Run npm run promote:songs after all intro reviews are complete.");
}
