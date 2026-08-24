import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const longlist = readJson("data/song-longlist.json").tracks;
const candidates = readJson("data/song-candidates.json").songs;
const catalog = readJson("public/catalog.json");

const requestedLimit = Number(process.argv.find((argument) => argument.startsWith("--limit="))?.split("=")[1]);
const reportLimit = Number.isInteger(requestedLimit) && requestedLimit >= 0 ? requestedLimit : 40;

function normalize(value = "") {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\b(?:feat(?:uring)?|ft)\.?\b.*$/u, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function titleKey(value = "") {
  return normalize(value)
    .replace(/\b(?:remaster(?:ed)?|radio edit|single version|album version|original mix|version)\b.*$/u, "")
    .trim();
}

function titleKeys(value = "") {
  const keys = new Set([titleKey(value)]);
  const withoutFeaturedParenthetical = value.replace(/\s*\((?:feat(?:uring)?|ft|with)\.?[^)]*\)/giu, "");
  keys.add(titleKey(withoutFeaturedParenthetical));
  return [...keys].filter(Boolean);
}

function artistTokens(value = "") {
  const ignored = new Set(["and", "the", "feat", "featuring", "ft"]);
  return new Set(normalize(value).split(" ").filter((token) => token && !ignored.has(token)));
}

function artistsOverlap(left, right) {
  const leftTokens = artistTokens(left);
  const rightTokens = artistTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return true;
  return [...leftTokens].some((token) => rightTokens.has(token));
}

const candidatesByTitle = new Map();
for (const candidate of candidates) {
  const keys = new Set([candidate.title, ...(candidate.aliases ?? [])].flatMap(titleKeys));
  for (const key of keys) {
    const matches = candidatesByTitle.get(key) ?? [];
    matches.push(candidate);
    candidatesByTitle.set(key, matches);
  }
}

const catalogIds = new Set(catalog.map((song) => song.id));
const activeBillionRows = longlist.filter((row) => row.signals?.includes("billion_streams"));

function candidateFor(row) {
  const possible = [...new Map(
    titleKeys(row.title)
      .flatMap((key) => candidatesByTitle.get(key) ?? [])
      .map((candidate) => [candidate.id, candidate]),
  ).values()];
  const artistMatches = possible.filter((candidate) => artistsOverlap(row.artist, candidate.artist));
  const matches = artistMatches.length > 0 ? artistMatches : possible;
  return matches.find((candidate) => catalogIds.has(candidate.id))
    ?? matches.find((candidate) => candidate.reviewStatus !== "rejected")
    ?? matches[0]
    ?? null;
}

const coverage = activeBillionRows.map((row) => {
  const candidate = candidateFor(row);
  return {
    row,
    candidate,
    playable: candidate ? catalogIds.has(candidate.id) : false,
  };
});

const candidateMatches = coverage.filter((entry) => entry.candidate);
const playableMatches = coverage.filter((entry) => entry.playable);
const candidateNotPlayable = coverage.filter((entry) => entry.candidate && !entry.playable);
const noCandidate = coverage.filter((entry) => !entry.candidate);
const missing = coverage.filter((entry) => !entry.playable);
const rejectedMatches = candidateMatches.filter((entry) => entry.candidate.reviewStatus === "rejected");

console.log("Billion-stream longlist coverage (conservative normalized title/artist matching)");
console.log(`Active billion-stream rows: ${activeBillionRows.length}`);
console.log(`Matched to candidate records: ${candidateMatches.length}`);
console.log(`Playable in public/catalog.json: ${playableMatches.length}`);
console.log(`Still missing from live play: ${missing.length}`);
console.log(`  No candidate record yet: ${noCandidate.length}`);
console.log(`  Candidate exists but is not playable: ${candidateNotPlayable.length}`);
console.log(`  Explicitly rejected candidate matches: ${rejectedMatches.length}`);

if (reportLimit > 0 && missing.length > 0) {
  console.log(`\nHighest-ranked missing rows (first ${Math.min(reportLimit, missing.length)}):`);
  for (const { row, candidate } of missing.slice(0, reportLimit)) {
    const state = candidate ? `candidate=${candidate.id}; status=${candidate.reviewStatus}` : "no candidate";
    console.log(`- #${row.sourceRank ?? "?"} ${row.title} — ${row.artist} (${row.displayedStreams ?? "stream total unavailable"}; ${state})`);
  }
}
