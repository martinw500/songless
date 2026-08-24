import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { difficultyFor } from "./provisional-scoring.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const audioDirectory = path.join(root, "public", "media", "audio");
const difficulties = new Set(["easy", "medium", "hard", "expert", "impossible"]);

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
if (!options.id) throw new Error("--id is required.");
const startAtSeconds = options["start-at"] === undefined ? null : Number(options["start-at"]);
if (startAtSeconds !== null && (!Number.isFinite(startAtSeconds) || startAtSeconds < 0)) {
  throw new Error("--start-at must be a non-negative number of seconds.");
}
const introRecognition = Number(options.intro);
if (!Number.isFinite(introRecognition) || introRecognition < 0 || introRecognition > 100) {
  throw new Error("--intro must be a number from 0 to 100 after reviewing the exact prepared clip.");
}

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const song = candidateRoot.songs.find((candidate) => candidate.id === options.id);
if (!song) throw new Error(`Unknown candidate id: ${options.id}`);
const hasLocalAudio = existsSync(path.join(audioDirectory, song.media.audioFile));
const hasHostedAudio = typeof song.media.hostedClueUrl === "string"
  && typeof song.media.hostedFullUrl === "string"
  && Number.isInteger(song.media.hostedDurationMs);
if (!hasLocalAudio && !hasHostedAudio) {
  throw new Error(`Playable media is missing for ${song.id}. Prepare a local file or upload it to R2.`);
}

const easeScore = Math.round(((song.familiarity + introRecognition) / 2) * 10) / 10;
const calculatedDifficulty = difficultyFor(easeScore);
const proposedDifficulty = options.difficulty ?? calculatedDifficulty;
if (!difficulties.has(proposedDifficulty)) throw new Error(`Unknown difficulty: ${proposedDifficulty}`);
if (proposedDifficulty !== calculatedDifficulty && !options.reason) {
  throw new Error(`Overriding ${calculatedDifficulty} with ${proposedDifficulty} requires --reason.`);
}
if (options["spotify-url"] && !/^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+(?:\?.*)?$/.test(options["spotify-url"])) {
  throw new Error("--spotify-url must be an open.spotify.com track URL.");
}

song.introRecognition = introRecognition;
song.easeScore = easeScore;
song.proposedDifficulty = proposedDifficulty;
song.difficultyOverrideReason = proposedDifficulty === calculatedDifficulty ? null : options.reason;
song.reviewStatus = "approved";
if (startAtSeconds !== null) song.startAtMs = Math.round(startAtSeconds * 1000);
if (options.album) song.album = options.album;
if (options["spotify-url"]) song.spotifyUrl = options["spotify-url"];

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`${song.title} — ${song.artist}: familiarity ${song.familiarity}, intro ${introRecognition}, ease ${easeScore}, ${proposedDifficulty}.`);
