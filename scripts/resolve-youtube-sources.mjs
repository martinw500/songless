import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sortCandidatesBillionFirst } from "./song-priority.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const longlistFile = path.join(root, "data", "song-longlist.json");
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
const manualUrl = valueAfter("--url");
const manualReason = valueAfter("--reason");
const force = args.includes("--force") || valueAfter("--force") === "true";
if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be from 1 to 500.");

const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs;
const longlist = JSON.parse(readFileSync(longlistFile, "utf8"));
const prioritizedCandidates = sortCandidatesBillionFirst(candidates, longlist);
const sourceRoot = JSON.parse(readFileSync(sourceFile, "utf8"));
const sourceById = new Map(sourceRoot.songs.map((song) => [song.id, song]));

function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsPhrase(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

const alteredVersion = /\b(live|concert|performance|sessions?|acoustic|stripped|orchestral|lullaby|animatic|footnotes|a ?cappella|acapella|remix|dub|medley|sped up|slowed|reverb|nightcore|cover|karaoke|instrumental|censored|clean version|radio edit|extended|edit|editions?|re[- ]?recorded|rerecorded|remake|w(?:\/|\s)?o|without|loop|reaction|bass boosted|8d|mashup|parody|tutorial|snippet|teaser|demo|unreleased|fan ?made|shorts?|compilation|playlist|interview|meaning|explained|breakdown|visuals?|visuali[sz]er|verified|ai (?:cover|version)|vocals? only|music only|version)\b/iu;
function hasUnexpectedFeature(versionText) {
  const featureText = versionText.match(/\b(?:feat|ft|featuring|with)\b([\s\S]*)/iu)?.[1];
  if (!featureText) return false;
  const remainder = featureText.replace(/\b(?:and|official|audio|video|music|lyrics?|visualizer|hd|4k)\b/giu, " ").trim();
  return /\p{L}/u.test(remainder);
}

function scoreResult(candidate, result, allowManualProvenance = false) {
  const resultTitle = normalize(result.title ?? "");
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const songTitle = titleOptions.find((title) => containsPhrase(resultTitle, title));
  const artistNames = candidate.primaryArtists.map(normalize);
  const channel = normalize(`${result.channel ?? ""} ${result.uploader ?? ""}`);
  const artistAliasNames = (candidate.artistAliases ?? []).map(normalize);
  const artistInChannel = [...artistNames, ...artistAliasNames].some((artist) => containsPhrase(channel, artist));
  const compactChannel = channel.replace(/\s+/gu, "");
  const compactArtistInChannel = [...artistNames, ...artistAliasNames]
    .map((artist) => artist.replace(/\s+/gu, ""))
    .some((artist) => artist.length >= 4 && compactChannel.includes(artist));
  if (!songTitle) return { accepted: false, reason: "title mismatch", score: -1 };
  const artistCoverage = artistNames.filter((artist) => containsPhrase(`${resultTitle} ${channel}`, artist));
  const aliasMatch = (candidate.artistAliases ?? []).map(normalize).some((artist) => containsPhrase(`${resultTitle} ${channel}`, artist));
  if (artistCoverage.length === 0 && !aliasMatch) {
    return { accepted: false, reason: "artist mismatch", score: -1 };
  }
  const officialChannel = artistInChannel || compactArtistInChannel || channel.includes("topic") || channel.includes("vevo")
    || containsPhrase(channel, "official")
    || (Boolean(result.channel_is_verified) && /\bofficial audio\b/iu.test(result.title ?? ""));
  if (!officialChannel && !allowManualProvenance) return { accepted: false, reason: "weak source provenance", score: -1 };

  let versionText = ` ${resultTitle} `;
  versionText = versionText.replace(` ${songTitle} `, " ");
  for (const artist of artistNames) {
    while (versionText.includes(` ${artist} `)) versionText = versionText.replace(` ${artist} `, " ");
  }
  if (alteredVersion.test(versionText)) return { accepted: false, reason: "altered version", score: -1 };
  if (hasUnexpectedFeature(versionText)) return { accepted: false, reason: "unexpected featured artist", score: -1 };
  if (/(official (music )?video|music video|making of|footnotes|behind the scenes|documentary|visuali[sz]er)/iu.test(resultTitle)) return { accepted: false, reason: "music video or behind scenes", score: -1 };
  
  const isTopic = /Topic/i.test(result.channel ?? "");
  const isAudio = /\bAudio\b/i.test(resultTitle);
  const isLyrics = /\bLyrics?\b/i.test(resultTitle);
  if (!isTopic && !isAudio && !isLyrics) {
    return { accepted: false, reason: "not a Topic channel or explicitly labeled Audio/Lyrics", score: -1 };
  }
  if (/\s\/\s/u.test(result.title ?? "") && !candidate.title.includes("/")) return { accepted: false, reason: "combined-song upload", score: -1 };
  if (result.live_status && result.live_status !== "not_live") return { accepted: false, reason: "live stream", score: -1 };
  if (!Number.isFinite(result.duration) || result.duration < 75 || result.duration > 720) {
    return { accepted: false, reason: "invalid full-song duration", score: -1 };
  }

  let score = 100;
  if (resultTitle === songTitle) score += 90;
  if (/\bofficial audio\b/iu.test(resultTitle)) score += 110;
  else if (/\baudio\b/iu.test(resultTitle)) score += 85;
  else if (/\bofficial lyric(?:s| video)?\b/iu.test(resultTitle)) score += 75;
  else if (/\bofficial (?:music )?video\b/iu.test(resultTitle)) score += 45;
  if (/\btopic\b/iu.test(channel) && artistInChannel) score += 90;
  if (artistInChannel) score += 70;
  if (result.channel_is_verified) score += 25;
  score += artistCoverage.length * 30;
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

if (manualUrl) {
  if (!selectedId || !manualReason) throw new Error("--url requires both --id and --reason for an auditable manual selection.");
  const candidate = candidates.find((item) => item.id === selectedId);
  const source = sourceById.get(selectedId);
  if (!candidate || !source) throw new Error(`Unknown candidate id: ${selectedId}`);
  const result = spawnSync("yt-dlp", ["--dump-single-json", "--no-playlist", "--no-warnings", manualUrl], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`YouTube inspection failed for ${selectedId}: ${result.stderr.trim()}`);
  const item = JSON.parse(result.stdout);
  const verdict = scoreResult(candidate, item, true);
  if (!verdict.accepted) throw new Error(`Manual source failed non-overridable checks for ${selectedId}: ${verdict.reason}`);
  source.url = manualUrl;
  source.youtube = {
    videoId: item.id,
    title: item.title,
    channel: item.channel ?? item.uploader,
    channelId: item.channel_id ?? item.uploader_id ?? null,
    durationSeconds: item.duration,
    channelVerified: Boolean(item.channel_is_verified),
    score: Math.round(verdict.score),
    manualReviewReason: manualReason,
    resolvedAt: new Date().toISOString(),
  };
  writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
  console.log(`MANUAL ${selectedId}: ${item.title} — ${item.channel ?? item.uploader} (${item.duration}s)`);
  process.exit(0);
}

let resolved = 0;
const unresolved = [];
for (const candidate of prioritizedCandidates) {
  if (selectedId && candidate.id !== selectedId) continue;
  const source = sourceById.get(candidate.id);
  if (!source) throw new Error(`Missing source row for ${candidate.id}. Run npm run init:sources.`);
  if (source.url && !force) continue;
  if (resolved >= limit) break;

  const selected = search(candidate);
  if (!selected) {
    if (force) {
      source.url = "";
      delete source.youtube;
    }
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
    channelId: item.channel_id ?? item.uploader_id ?? null,
    durationSeconds: item.duration,
    channelVerified: Boolean(item.channel_is_verified),
    score: Math.round(selected.score),
    resolvedAt: new Date().toISOString(),
  };
  resolved += 1;
  console.log(`SELECT ${candidate.id}: ${item.title} — ${item.channel} (${item.duration}s)`);
}

writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
console.log(`Resolved ${resolved} YouTube source(s).${unresolved.length ? ` Manual review needed: ${unresolved.join(", ")}` : ""}`);
