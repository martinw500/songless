import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const sourceFile = path.join(root, "data", "song-download-sources.local.json");
const args = process.argv.slice(2);
const valueAfter = (name) => {
  const assigned = args.find((argument) => argument.startsWith(`${name}=`));
  if (assigned) return assigned.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const positionalLimit = args.find((argument) => /^\d+$/u.test(argument));
const limit = Number(valueAfter("--limit") ?? positionalLimit ?? 5);
const selectedId = valueAfter("--id");
const force = args.includes("--force") || valueAfter("--force") === "true";
if (!Number.isInteger(limit) || limit < 1 || limit > 120) throw new Error("--limit must be from 1 to 120.");

const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs;
const sourceRoot = JSON.parse(readFileSync(sourceFile, "utf8"));
const sourceById = new Map(sourceRoot.songs.map((song) => [song.id, song]));

function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsPhrase(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

const alteredVersion = /\b(live|concert|performance|acoustic|remix|remastered|sped up|slowed|reverb|nightcore|cover|karaoke|instrumental|censored|clean version|radio edit|extended|loop|reaction|bass boosted|8d|mashup|parody|tutorial)\b/iu;

function scoreResult(candidate, result) {
  const resultTitle = normalize(result.title ?? "");
  const songTitle = normalize(candidate.title);
  const artistNames = candidate.primaryArtists.map(normalize);
  const channel = normalize(`${result.channel ?? ""} ${result.uploader ?? ""}`);
  const artistInChannel = artistNames.some((artist) => containsPhrase(channel, artist));
  if (!containsPhrase(resultTitle, songTitle)) return { accepted: false, reason: "title mismatch", score: -1 };
  if (!artistNames.some((artist) => containsPhrase(`${resultTitle} ${channel}`, artist))) {
    return { accepted: false, reason: "artist mismatch", score: -1 };
  }

  let versionText = ` ${resultTitle} `;
  versionText = versionText.replace(` ${songTitle} `, " ");
  for (const artist of artistNames) versionText = versionText.replace(` ${artist} `, " ");
  if (alteredVersion.test(versionText)) return { accepted: false, reason: "altered version", score: -1 };
  if (result.live_status && result.live_status !== "not_live") return { accepted: false, reason: "live stream", score: -1 };

  let score = 100;
  if (resultTitle === songTitle) score += 90;
  if (/\bofficial audio\b/iu.test(resultTitle)) score += 110;
  else if (/\baudio\b/iu.test(resultTitle)) score += 85;
  else if (/\bofficial lyric(?:s| video)?\b/iu.test(resultTitle)) score += 75;
  else if (/\bofficial (?:music )?video\b/iu.test(resultTitle)) score += 45;
  if (/\btopic\b/iu.test(channel) && artistInChannel) score += 90;
  if (artistInChannel) score += 70;
  if (result.channel_is_verified) score += 25;
  score += Math.min(25, Math.log10(Math.max(1, result.view_count ?? 1)) * 3);
  return { accepted: true, reason: "studio/original candidate", score };
}

function search(candidate) {
  const query = `ytsearch8:${candidate.artist} ${candidate.title} official audio topic`;
  const result = spawnSync("yt-dlp", ["--dump-single-json", "--flat-playlist", "--playlist-end", "8", "--no-warnings", query], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`YouTube search failed for ${candidate.id}: ${result.stderr.trim()}`);
  const entries = JSON.parse(result.stdout).entries ?? [];
  const ranked = entries.map((entry) => ({ entry, ...scoreResult(candidate, entry) }))
    .filter((item) => item.accepted)
    .sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
}

let resolved = 0;
const unresolved = [];
for (const candidate of candidates) {
  if (selectedId && candidate.id !== selectedId) continue;
  const source = sourceById.get(candidate.id);
  if (!source) throw new Error(`Missing source row for ${candidate.id}. Run npm run init:sources.`);
  if (source.url && !force) continue;
  if (resolved >= limit) break;

  const selected = search(candidate);
  if (!selected) {
    unresolved.push(candidate.id);
    console.log(`REVIEW ${candidate.id}: no unaltered studio result passed the filters.`);
    continue;
  }
  const item = selected.entry;
  source.url = item.url;
  source.youtube = {
    videoId: item.id,
    title: item.title,
    channel: item.channel,
    durationSeconds: item.duration,
    score: Math.round(selected.score),
    resolvedAt: new Date().toISOString(),
  };
  resolved += 1;
  console.log(`SELECT ${candidate.id}: ${item.title} — ${item.channel} (${item.duration}s)`);
}

writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
console.log(`Resolved ${resolved} YouTube source(s).${unresolved.length ? ` Manual review needed: ${unresolved.join(", ")}` : ""}`);
