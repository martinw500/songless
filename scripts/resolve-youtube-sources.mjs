import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sortCandidatesBillionFirst } from "./song-priority.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const longlistFile = path.join(root, "data", "song-longlist.json");
const sourceFile = path.join(root, "data", "song-download-sources.local.json");
const lockFile = path.join(root, "data", "resolve-youtube-sources.local.lock");
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
const batchFile = valueAfter("--batch-file");
const manualUrl = valueAfter("--url");
const manualReason = valueAfter("--reason");
const force = args.includes("--force") || valueAfter("--force") === "true";
const revalidate = args.includes("--revalidate");
const concurrency = Number(valueAfter("--concurrency") ?? 4);
const searchSize = Number(valueAfter("--search-size") ?? 15);
if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be from 1 to 500.");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--concurrency must be from 1 to 8.");
if (!Number.isInteger(searchSize) || searchSize < 10 || searchSize > 50) throw new Error("--search-size must be from 10 to 50.");

if (existsSync(lockFile)) {
  const previousPid = Number(readFileSync(lockFile, "utf8").trim());
  let running = false;
  if (Number.isInteger(previousPid)) {
    try { process.kill(previousPid, 0); running = true; } catch { /* stale lock */ }
  }
  if (running) throw new Error(`Another YouTube resolver is already running (pid ${previousPid}).`);
  unlinkSync(lockFile);
}
writeFileSync(lockFile, `${process.pid}\n`, "utf8");
const removeLock = () => {
  try {
    if (existsSync(lockFile) && Number(readFileSync(lockFile, "utf8").trim()) === process.pid) unlinkSync(lockFile);
  } catch { /* process shutdown */ }
};
process.on("exit", removeLock);

const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs;
const longlist = JSON.parse(readFileSync(longlistFile, "utf8"));
const prioritizedCandidates = sortCandidatesBillionFirst(candidates, longlist);
const sourceRoot = JSON.parse(readFileSync(sourceFile, "utf8"));
const sourceById = new Map(sourceRoot.songs.map((song) => [song.id, song]));
const selectedIds = new Set(selectedId ? selectedId.split(",").map((id) => id.trim()).filter(Boolean) : []);
if (batchFile) {
  const batch = JSON.parse(readFileSync(path.resolve(root, batchFile), "utf8"));
  for (const song of batch.selected ?? []) selectedIds.add(song.id);
}

function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function baseTitle(value) {
  return normalize(value)
    .replace(/\b(?:feat(?:uring)?|ft|with)\b.*$/u, "")
    .replace(/\b(?:from|radio edit|radio mix|remaster(?:ed)?|explicit ver(?:sion)?)\b.*$/u, "")
    .trim();
}

function containsPhrase(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

const alteredVersion = /\b(live|concert|performance|sessions?|acoustic|stripped|orchestral|lullaby|animatic|footnotes|a ?cappella|acapella|remix|radio mix|dub|medley|sped up|slowed|reverb|nightcore|cover|karaoke|instrumental|censored|clean|radio edit|extended|edit|editions?|alt(?:ernate)? version|reloaded|remaster(?:ed)?|re[- ]?recorded|rerecorded|remake|reworked|reimagined|unplugged|synthesis|preview|w(?:\/|\s)?o|without|loop|reaction|bass boosted|\d+d|432\s*hz|pitch(?:ed)?|surround|headphones?|mashup|parody|tutorial|snippet|teaser|demo|unreleased|fan ?made|shorts?|compilation|playlist|interview|meaning|explained|breakdown|visuals?|visuali[sz]er|verified|ai (?:cover|version)|vocals? only|music only|version)\b/iu;
function hasUnexpectedFeature(versionText) {
  const featureText = versionText.match(/\b(?:feat|ft|featuring|with)\b([\s\S]*)/iu)?.[1];
  if (!featureText) return false;
  const remainder = featureText.replace(/\b(?:and|official|audio|video|music|lyrics?|visualizer|hd|4k)\b/giu, " ").trim();
  return /\p{L}/u.test(remainder);
}

function scoreResult(candidate, result, allowManualProvenance = false) {
  const resultTitle = normalize(result.title ?? "");
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])]
    .flatMap((title) => [normalize(title), baseTitle(title)]).filter(Boolean);
  const songTitle = titleOptions.find((title) => containsPhrase(resultTitle, title));
  const artistNames = candidate.primaryArtists.map(normalize);
  const channel = normalize(result.channel ?? result.uploader ?? "");
  const artistAliasNames = (candidate.artistAliases ?? []).map(normalize);
  const verifiedChannel = Boolean(result.channel_is_verified ?? result.channelVerified);
  const channelNames = [...artistNames, ...artistAliasNames];
  const artistInChannel = channelNames.some((artist) => channel === artist || channel === `${artist} topic`);
  const compactChannel = channel.replace(/\s+/gu, "");
  const compactArtistInChannel = channelNames
    .map((artist) => artist.replace(/\s+/gu, ""))
    .some((artist) => artist.length >= 4 && (compactChannel === artist
      || compactChannel === `${artist}topic`
      || (verifiedChannel && /^(?:official|music|videos|vevo)$/u.test(compactChannel.slice(artist.length))
        && compactChannel.startsWith(artist))));
  if (!songTitle) return { accepted: false, reason: "title mismatch", score: -1 };
  const artistCoverage = artistNames.filter((artist) => containsPhrase(`${resultTitle} ${channel}`, artist));
  const aliasMatch = (candidate.artistAliases ?? []).map(normalize).some((artist) => containsPhrase(`${resultTitle} ${channel}`, artist));
  if (artistCoverage.length === 0 && !aliasMatch) {
    return { accepted: false, reason: "artist mismatch", score: -1 };
  }
  const officialChannel = artistInChannel || compactArtistInChannel;
  const canonicalDurationSeconds = Number(candidate.itunesDurationMs ?? candidate.spotifyDurationMs) / 1000;
  const durationMatchesCanonical = Number.isFinite(canonicalDurationSeconds) && canonicalDurationSeconds > 0
    && Number.isFinite(result.duration) && Math.abs(result.duration - canonicalDurationSeconds) <= 3;
  const isTopic = /Topic/i.test(result.channel ?? "");
  const isAudio = /\bAudio\b/i.test(resultTitle);
  const isLyrics = /\bLyrics?\b/i.test(resultTitle);
  const fingerprintGatedMirror = !officialChannel && durationMatchesCanonical && (isTopic || isAudio || isLyrics);
  if (!officialChannel && !allowManualProvenance && !fingerprintGatedMirror) {
    return { accepted: false, reason: "weak source provenance", score: -1 };
  }
  const officialMusicVideo = /\bofficial\s+(?:(?:music|4k)\s+)?video\b/iu.test(result.title ?? "");
  const fingerprintGatedVideo = officialMusicVideo && verifiedChannel
    && (artistInChannel || compactArtistInChannel) && durationMatchesCanonical;

  let versionText = ` ${resultTitle} `;
  versionText = versionText.replace(` ${songTitle} `, " ");
  for (const artist of artistNames) {
    while (versionText.includes(` ${artist} `)) versionText = versionText.replace(` ${artist} `, " ");
  }
  if (alteredVersion.test(versionText)) return { accepted: false, reason: "altered version", score: -1 };
  if (hasUnexpectedFeature(versionText)) return { accepted: false, reason: "unexpected featured artist", score: -1 };
  if (/(making of|footnotes|behind the scenes|documentary|visuali[sz]er)/iu.test(resultTitle)
    || (/\bmusic video\b/iu.test(resultTitle) && !fingerprintGatedVideo)) {
    return { accepted: false, reason: "music video or behind scenes", score: -1 };
  }
  
  if (!isTopic && !isAudio && !isLyrics && !fingerprintGatedVideo) {
    return { accepted: false, reason: "not a Topic channel or explicitly labeled Audio/Lyrics", score: -1 };
  }
  if (/\s\/\s/u.test(result.title ?? "") && !candidate.title.includes("/")) return { accepted: false, reason: "combined-song upload", score: -1 };
  if (result.live_status && result.live_status !== "not_live") return { accepted: false, reason: "live stream", score: -1 };
  if (!Number.isFinite(result.duration) || result.duration < 75 || result.duration > 720) {
    return { accepted: false, reason: "invalid full-song duration", score: -1 };
  }
  if (Number.isFinite(canonicalDurationSeconds) && canonicalDurationSeconds > 0
    && Math.abs(result.duration - canonicalDurationSeconds) > 3) {
    return { accepted: false, reason: "canonical duration mismatch", score: -1 };
  }

  let score = 100;
  if (resultTitle === songTitle) score += 90;
  if (/\bofficial audio\b/iu.test(resultTitle)) score += 110;
  else if (/\baudio\b/iu.test(resultTitle)) score += 85;
  else if (/\bofficial lyric(?:s| video)?\b/iu.test(resultTitle)) score += 75;
  else if (/\bofficial (?:music )?video\b/iu.test(resultTitle)) score += 45;
  if (/\btopic\b/iu.test(channel) && (artistInChannel || compactArtistInChannel)) score += 90;
  if (artistInChannel) score += 70;
  if (verifiedChannel) score += 25;
  score += artistCoverage.length * 30;
  score += Math.min(25, Math.log10(Math.max(1, result.view_count ?? 1)) * 3);
  return {
    accepted: true,
    reason: fingerprintGatedVideo ? "verified artist video; fingerprint required"
      : fingerprintGatedMirror ? "duration-verified mirror; fingerprint required" : "studio/original candidate",
    requiresCanonicalFingerprint: fingerprintGatedVideo || fingerprintGatedMirror,
    score,
  };
}

function runSearch(query) {
  return new Promise((resolve, reject) => {
    execFile("yt-dlp", ["--dump-single-json", "--flat-playlist", "--playlist-end", String(searchSize), "--no-warnings", query], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 45_000,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(JSON.parse(stdout));
    });
  });
}

async function search(candidate) {
  const lead = candidate.primaryArtists[0] ?? candidate.artist;
  const title = baseTitle(candidate.title);
  const entries = [];
  const seen = new Set();
  const queries = [`ytsearch${searchSize}:${lead} ${title} topic`, `ytsearch${searchSize}:${lead} ${title} official audio`];
  const results = await Promise.allSettled(queries.map(runSearch));
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  if (fulfilled.length === 0) {
    throw new Error(`YouTube search failed for ${candidate.id}: ${results.map((result) => result.reason?.message).filter(Boolean).join("; ")}`);
  }
  for (const result of fulfilled) {
    for (const entry of result.value.entries ?? []) {
      if (!seen.has(entry.id)) entries.push(entry);
      seen.add(entry.id);
    }
  }
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
if (!revalidate) {
  const queue = prioritizedCandidates.filter((candidate) => {
    if (selectedIds.size > 0 && !selectedIds.has(candidate.id)) return false;
    const source = sourceById.get(candidate.id);
    if (!source) throw new Error(`Missing source row for ${candidate.id}. Run npm run init:sources.`);
    return force || !source.url;
  });
  for (let index = 0; index < queue.length && resolved < limit; index += concurrency) {
    const chunk = queue.slice(index, index + Math.min(concurrency, limit - resolved));
    const results = await Promise.all(chunk.map(async (candidate) => {
      try { return { candidate, selected: await search(candidate) }; }
      catch (error) { return { candidate, error }; }
    }));
    for (const result of results) {
      const { candidate } = result;
      const source = sourceById.get(candidate.id);
      if (result.error || !result.selected) {
        if (force) { source.url = ""; delete source.youtube; }
        unresolved.push(candidate.id);
        console.log(`REVIEW ${candidate.id}: ${result.error?.message ?? "no unaltered studio result passed the filters."}`);
        continue;
      }
      const item = result.selected.entry;
      source.url = item.url;
      source.youtube = {
        videoId: item.id,
        title: item.title,
        channel: item.channel,
        channelId: item.channel_id ?? item.uploader_id ?? null,
        durationSeconds: item.duration,
        channelVerified: Boolean(item.channel_is_verified),
        score: Math.round(result.selected.score),
        ...(result.selected.requiresCanonicalFingerprint ? { requiresCanonicalFingerprint: true } : {}),
        resolvedAt: new Date().toISOString(),
      };
      resolved += 1;
      console.log(`SELECT ${candidate.id}: ${item.title} â€” ${item.channel} (${item.duration}s)`);
    }
    writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
  }
  console.log(`Resolved ${resolved} YouTube source(s).${unresolved.length ? ` Manual review needed: ${unresolved.join(", ")}` : ""}`);
  process.exit(0);
}
for (const candidate of prioritizedCandidates) {
  if (selectedIds.size > 0 && !selectedIds.has(candidate.id)) continue;
  const source = sourceById.get(candidate.id);
  if (!source) throw new Error(`Missing source row for ${candidate.id}. Run npm run init:sources.`);
  if (revalidate) {
    if (!source.url || !source.youtube) continue;
    const verdict = scoreResult(candidate, {
      ...source.youtube,
      channel_is_verified: source.youtube.channelVerified,
      duration: source.youtube.durationSeconds,
    });
    if (!verdict.accepted) {
      source.url = "";
      delete source.youtube;
      unresolved.push(candidate.id);
      console.log(`CLEARED ${candidate.id}: ${verdict.reason}.`);
    } else {
      if (verdict.requiresCanonicalFingerprint) source.youtube.requiresCanonicalFingerprint = true;
      else delete source.youtube.requiresCanonicalFingerprint;
      resolved += 1;
    }
    continue;
  }
  if (source.url && !force) continue;
  if (resolved >= limit) break;

  const selected = await search(candidate);
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
    ...(selected.requiresCanonicalFingerprint ? { requiresCanonicalFingerprint: true } : {}),
    resolvedAt: new Date().toISOString(),
  };
  resolved += 1;
  writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
  console.log(`SELECT ${candidate.id}: ${item.title} — ${item.channel} (${item.duration}s)`);
}

writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
console.log(`${revalidate ? "Revalidated" : "Resolved"} ${resolved} YouTube source(s).${unresolved.length ? ` Manual review needed: ${unresolved.join(", ")}` : ""}`);
