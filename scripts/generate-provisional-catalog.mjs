import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
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
    s.media?.hostedClueUrl &&
    s.media?.hostedFullUrl &&
    Number.isInteger(s.media.hostedDurationMs)
);

if (songs.length !== 120) {
  console.error(`Expected 120 hosted songs; found ${songs.length}. Cannot generate provisional catalogue.`);
  process.exit(1);
}

// For songs without intro scores yet, use familiarity alone as a provisional ease
const withEase = songs.map((s) => {
  const introRecog = s.introRecognition ?? null;
  const easeScore =
    introRecog !== null
      ? Math.round(((s.familiarity + introRecog) / 2) * 10) / 10
      : s.familiarity; // use familiarity as provisional ease when intro not yet reviewed
  return { song: s, easeScore, hasIntroReview: introRecog !== null };
});

// Sort by ease descending
withEase.sort((a, b) => b.easeScore - a.easeScore);

// Assign provisional quantile bands
const bands = ["easy", "medium", "hard", "expert", "impossible"];
const bandSize = 24;

const catalog = withEase.map((entry, index) => {
  const s = entry.song;
  const difficulty = bands[Math.floor(index / bandSize)];
  const artwork = s.media.artworkUrl || undefined;

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
    difficulty,
    familiarity: s.familiarity,
    ...(s.introRecognition !== null ? { introRecognition: s.introRecognition } : {}),
    startAtMs: s.startAtMs ?? 0,
    ...(artwork ? { artwork } : {}),
    audio: {
      kind: "hosted",
      clueSrc: s.media.hostedClueUrl,
      fullSrc: s.media.hostedFullUrl,
      durationMs: s.media.hostedDurationMs,
    },
    _provisional: true,
    _provisionalMethod: entry.hasIntroReview ? "ease_score" : "familiarity_only",
    _easeScore: entry.easeScore,
    _rank: index + 1,
  };
});

// Count per difficulty
const counts = {};
for (const entry of catalog) counts[entry.difficulty] = (counts[entry.difficulty] || 0) + 1;

console.log(`\n=== Provisional Catalogue ===`);
console.log(`Total songs: ${catalog.length}`);
console.log(`Method: quantile bands (${bandSize} per difficulty)`);
for (const d of bands) console.log(`  ${d}: ${counts[d] || 0}`);

const withIntro = withEase.filter((e) => e.hasIntroReview).length;
const withoutIntro = withEase.length - withIntro;
console.log(`\nIntro reviewed: ${withIntro}`);
console.log(`Familiarity-only (provisional): ${withoutIntro}`);
console.log(`\nEase score range: ${withEase[withEase.length - 1].easeScore} – ${withEase[0].easeScore}`);

// Show band boundaries
for (let i = 0; i < bands.length; i++) {
  const start = i * bandSize;
  const end = start + bandSize - 1;
  const hi = withEase[start].easeScore;
  const lo = withEase[end].easeScore;
  console.log(`  ${bands[i].padEnd(11)} rank ${start + 1}–${end + 1}  ease ${lo}–${hi}`);
}

if (dryRun) {
  console.log("\n[DRY RUN] No files written.");
} else {
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(`\nWrote provisional catalogue to ${path.basename(catalogFile)}.`);
  console.log("⚠ This is a PROVISIONAL catalogue for testing only.");
  console.log("  Difficulties are quantile-calibrated and will change after intro review.");
  console.log("  Run npm run promote:songs after all intro reviews are complete.");
}
