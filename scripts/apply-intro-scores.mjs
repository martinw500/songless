import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { difficultyFor } from "./provisional-scoring.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    options[key.slice(2)] = argv[++index];
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));

// Read scores from file or stdin
let scores;
if (options.file) {
  if (!existsSync(options.file)) throw new Error(`Score file not found: ${options.file}`);
  scores = JSON.parse(readFileSync(options.file, "utf8"));
} else if (options.clipboard) {
  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  scores = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} else {
  throw new Error("Usage: node apply-intro-scores.mjs --file <path-to-scores.json>\n\nThe scores file should be exported from the intro-review interface.");
}

if (!Array.isArray(scores) || scores.length === 0) {
  throw new Error("Score file must be a non-empty JSON array.");
}

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const songMap = new Map(candidateRoot.songs.map(s => [s.id, s]));

// Validate and preview
const updates = [];
const notFound = [];
for (const entry of scores) {
  if (!entry.id || typeof entry.introRecognition !== "number") {
    console.warn(`Skipping invalid entry: ${JSON.stringify(entry)}`);
    continue;
  }
  if (entry.introRecognition < 0 || entry.introRecognition > 100) {
    console.warn(`Skipping out-of-range score for ${entry.id}: ${entry.introRecognition}`);
    continue;
  }
  const song = songMap.get(entry.id);
  if (!song) {
    notFound.push(entry.id);
    continue;
  }
  const easeScore = Math.round(((song.familiarity + entry.introRecognition) / 2) * 10) / 10;
  const difficulty = difficultyFor(easeScore);
  updates.push({
    id: entry.id,
    title: song.title,
    artist: song.artist,
    familiarity: song.familiarity,
    introRecognition: entry.introRecognition,
    easeScore,
    difficulty,
    recognizedAt: entry.recognizedAt,
  });
}

if (notFound.length > 0) {
  console.warn(`\nCandidates not found: ${notFound.join(", ")}`);
}

// Preview
console.log(`\n=== Intro Score Preview ===`);
console.log(`Scores to apply: ${updates.length}`);
console.log("");

// Sort by ease for preview
const sorted = [...updates].sort((a, b) => b.easeScore - a.easeScore);
for (const u of sorted) {
  const recog = u.recognizedAt !== null && u.recognizedAt !== undefined
    ? (u.recognizedAt === 999 ? "after 15s" : u.recognizedAt + "s")
    : "n/a";
  console.log(`  ${u.difficulty.padEnd(11)} ${String(u.easeScore).padStart(5)}  fam=${u.familiarity} intro=${u.introRecognition} (${recog})  ${u.title} — ${u.artist}`);
}

// Difficulty distribution
const diffCounts = {};
for (const u of updates) diffCounts[u.difficulty] = (diffCounts[u.difficulty] || 0) + 1;
console.log(`\nDifficulty distribution:`);
for (const d of ["easy", "medium", "hard", "expert", "impossible"]) {
  console.log(`  ${d}: ${diffCounts[d] || 0}`);
}

if (options["dry-run"] === "true" || options["dry-run"] === undefined) {
  console.log("\n[DRY RUN] No changes written. Run with --dry-run false to apply.\n");
  process.exit(0);
}

// Apply updates
let applied = 0;
for (const u of updates) {
  const song = songMap.get(u.id);
  song.introRecognition = u.introRecognition;
  song.easeScore = u.easeScore;
  song.proposedDifficulty = u.difficulty;
  song.difficultyOverrideReason = null;
  song.reviewStatus = "approved";
  applied += 1;
}

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`\nApplied intro scores to ${applied} songs in song-candidates.json.`);
console.log("Run npm run audit:songs to validate.");
