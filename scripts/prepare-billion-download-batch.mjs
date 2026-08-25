import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const longlistFile = path.join(root, "data", "song-longlist.json");
const catalogFile = path.join(root, "public", "catalog.json");
const cacheDirectory = path.join(root, "data", "billion-candidate-metadata.local");
const reportFile = path.join(root, "data", "billion-download-batch.local.json");
const apply = process.argv.includes("--apply");
const refresh = process.argv.includes("--refresh");
const refreshExisting = process.argv.includes("--refresh-existing");
const target = Number(process.argv.find((argument) => argument.startsWith("--target="))?.split("=")[1] ?? 200);
if (!Number.isInteger(target) || target < 1 || target > 500) throw new Error("--target must be from 1 to 500.");

mkdirSync(cacheDirectory, { recursive: true });
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const longlist = JSON.parse(readFileSync(longlistFile, "utf8"));
const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
const catalogIds = new Set(catalog.map((song) => song.id));

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function baseTitle(value = "") {
  return normalize(value)
    .replace(/\b(?:feat(?:uring)?|ft|with)\b.*$/u, "")
    .replace(/\b(?:remaster(?:ed)?|radio edit|radio mix|single version|album version|explicit ver(?:sion)?)\b.*$/u, "")
    .trim();
}

function slug(value) {
  return normalize(value).replace(/\s+/gu, "-").replace(/^-|-$/gu, "");
}

function artistTokens(value = "") {
  return new Set(normalize(value).split(" ").filter((token) => token && !["and", "the"].includes(token)));
}

function artistsOverlap(left, right) {
  const leftTokens = artistTokens(left);
  const rightTokens = artistTokens(right);
  return [...leftTokens].some((token) => rightTokens.has(token));
}

function candidateFor(row) {
  const title = baseTitle(row.title);
  const possible = candidateRoot.songs.filter((candidate) => (
    [candidate.title, ...(candidate.aliases ?? [])].some((value) => baseTitle(value) === title)
    && artistsOverlap(row.artist, candidate.artist)
  ));
  return possible.find((candidate) => catalogIds.has(candidate.id))
    ?? possible.find((candidate) => candidate.reviewStatus !== "rejected")
    ?? possible[0]
    ?? null;
}

function versionSignals(value = "") {
  return new Set(normalize(value).match(/\b(?:live|acoustic|remix|mixed|remaster(?:ed)?|radio edit|radio mix|clean|sped|slowed|band ver(?:sion)?|summer mix|opening title version|explicit ver(?:sion)?|single version|album version|alt(?:ernate)? version|reloaded|taylor s version|edition|instrumental|karaoke|cover)\b/gu) ?? []);
}

function versionsAgree(requestedValue, resultValue) {
  const requested = versionSignals(requestedValue);
  const result = versionSignals(resultValue);
  return [...result].every((signal) => requested.has(signal))
    && [...requested].every((signal) => result.has(signal));
}

function alteredAlbum(value = "") {
  return /\b(?:live|unplugged|remix(?:es|ed)?|reworked|reimagined|covers?|karaoke|tribute|instrumental|orchestral|acoustic)\b/iu.test(value);
}

function albumAlterationAllowed(requestedTitle, album) {
  if (!alteredAlbum(album)) return true;
  const requested = normalize(requestedTitle);
  const normalizedAlbum = normalize(album);
  if (/\bremix(?:es|ed)?\b/u.test(normalizedAlbum) && /\bremix\b/u.test(requested)) return true;
  if (/\blive\b/u.test(normalizedAlbum) && /\blive\b/u.test(requested)) return true;
  if (/\bacoustic\b/u.test(normalizedAlbum) && /\bacoustic\b/u.test(requested)) return true;
  return false;
}

function compilationAlbum(value = "") {
  return /\b(?:greatest hits|best of|essentials|top hits|party hits|sad songs|decade of|bangers|valentine|complete studio albums|once upon a time in|roots of|workout|fitness|running|cardio|body by|exercise|megamix|sing along|now:?\s*\d|now\s+\d|this is it)\b/iu.test(value)
    || /#1/u.test(value);
}

function leadArtistMatches(expected, actual) {
  const lead = normalize(expected);
  const artist = normalize(actual);
  return artist === lead || artist.startsWith(`${lead} and `) || artist.startsWith(`${lead} feat `)
    || artist.startsWith(`${lead} with `);
}

function metadataAcceptable(row, metadata) {
  if (metadata?.status !== "matched") return false;
  const album = metadata.albumName ?? "";
  const artistText = [metadata.artistName, ...(metadata.artists ?? [])].filter(Boolean).join(" ");
  return versionsAgree(row.title, metadata.trackName ?? "")
    && leadArtistMatches(row.artist, metadata.artistName ?? "")
    && albumAlterationAllowed(row.title, album)
    && !compilationAlbum(album)
    && !/\b(?:karaoke|tribute|cover band|made famous|in the style of)\b/iu.test(artistText)
    && Number.isFinite(metadata.durationMs) && metadata.durationMs >= 75_000
    && Number.isInteger(metadata.releaseYear) && metadata.releaseYear >= 1900 && metadata.releaseYear <= 2026
    && /^https:\/\//u.test(metadata.artworkUrl ?? "");
}

function inspectItunes(row, result) {
  const requestedBase = baseTitle(row.title);
  const resultBase = baseTitle(result.trackName);
  const titleMatch = requestedBase === resultBase;
  const leadMatch = leadArtistMatches(row.artist, result.artistName ?? "");
  const requestedVersions = versionSignals(row.title);
  const resultVersions = versionSignals(`${result.trackName ?? ""} ${result.collectionName ?? ""}`);
  const versionMatch = versionsAgree(row.title, result.trackName ?? "");
  const compilation = compilationAlbum(result.collectionName ?? "")
    || !albumAlterationAllowed(row.title, result.collectionName ?? "")
    || /\b(?:karaoke|tribute|made famous|in the style of|cover band)\b/iu.test(result.artistName ?? "");
  const year = Number(String(result.releaseDate ?? "").slice(0, 4));
  const albumArtistMatch = leadArtistMatches(row.artist, result.collectionArtistName ?? result.artistName ?? "");
  const valid = titleMatch && leadMatch && versionMatch && !compilation
    && Number.isInteger(year) && year >= 1900 && year <= 2026
    && Number.isFinite(result.trackTimeMillis) && result.trackTimeMillis >= 75_000
    && /^https:\/\//u.test(result.artworkUrl100 ?? "");
  const exactTitle = normalize(row.title) === normalize(result.trackName ?? "");
  const exactLead = normalize(result.artistName ?? "").includes(normalize(row.artist));
  const score = (exactTitle ? 500 : titleMatch ? 300 : -500)
    + (exactLead ? 250 : leadMatch ? 150 : -500)
    + (albumArtistMatch ? 350 : -250)
    + (requestedVersions.size === resultVersions.size ? 80 : 0)
    - (compilation ? 1000 : 0)
    - (versionMatch ? 0 : 1000);
  return { valid, score };
}

async function searchItunes(row) {
  const cacheFile = path.join(cacheDirectory, `${row.sourceRank}-${slug(`${row.artist}-${row.title}`)}.json`);
  if (existsSync(cacheFile) && !refresh) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (metadataAcceptable(row, cached)) return cached;
  }
  const allResults = [];
  for (const country of ["CA", "US"]) {
    const query = encodeURIComponent(`${row.title} ${row.artist}`);
    const response = await fetch(`https://itunes.apple.com/search?entity=song&country=${country}&limit=25&term=${query}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`iTunes ${country} search returned ${response.status}`);
    const payload = await response.json();
    allResults.push(...(payload.results ?? []));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const ranked = allResults.map((result) => ({ result, ...inspectItunes(row, result) }))
    .filter((entry) => entry.valid)
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0]?.result;
  const metadata = selected ? {
    status: "matched",
    trackId: selected.trackId,
    trackName: selected.trackName,
    artistName: selected.artistName,
    albumArtistName: selected.collectionArtistName ?? null,
    albumName: selected.collectionName,
    releaseYear: Number(String(selected.releaseDate).slice(0, 4)),
    genre: selected.primaryGenreName || "Pop",
    durationMs: Math.round(selected.trackTimeMillis),
    artworkUrl: selected.artworkUrl100.replace(/100x100(?:bb)?\.(?:jpg|png)$/iu, "600x600bb.jpg"),
    trackUrl: selected.trackViewUrl ?? null,
    previewUrl: selected.previewUrl ?? null,
  } : { status: "no_strict_match" };
  writeFileSync(cacheFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}

function inspectDeezer(row, result) {
  const requestedBase = baseTitle(row.title);
  const resultBase = baseTitle(result.title_short ?? result.title);
  const titleMatch = requestedBase === resultBase;
  const credits = [result.artist?.name, ...(result.contributors ?? []).map((artist) => artist.name)].filter(Boolean);
  const leadMatch = leadArtistMatches(row.artist, result.artist?.name ?? "");
  const versionMatch = versionsAgree(row.title, result.title ?? "");
  const compilation = compilationAlbum(result.album?.title ?? "") || !albumAlterationAllowed(row.title, result.album?.title ?? "")
    || /\b(?:karaoke|tribute|made famous|in the style of|cover band)\b/iu.test(credits.join(" "));
  const suspiciousCredit = credits.some((artist) => /\b(?:karaoke|tribute|cover band|made famous|in the style of)\b/iu.test(artist));
  const valid = titleMatch && leadMatch && versionMatch && !compilation && !suspiciousCredit
    && Number.isFinite(Number(result.duration)) && Number(result.duration) >= 75
    && /^https:\/\//u.test(result.album?.cover_xl ?? result.album?.cover_big ?? "");
  const score = (normalize(row.title) === normalize(result.title ?? "") ? 500 : titleMatch ? 300 : -500)
    + (normalize(result.artist?.name ?? "") === normalize(row.artist) ? 250 : leadMatch ? 150 : -500)
    + Math.log10(Math.max(1, Number(result.rank) || 1)) * 100
    - (compilation || suspiciousCredit ? 1000 : 0) - (versionMatch ? 0 : 1000);
  return { valid, score };
}

async function searchDeezer(row) {
  const query = encodeURIComponent(`${row.title} ${row.artist}`);
  const response = await fetch(`https://api.deezer.com/search?q=${query}&limit=50`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Deezer search returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Deezer API error ${payload.error.code}: ${payload.error.message}`);
  const ranked = (payload.data ?? []).map((result) => ({ result, ...inspectDeezer(row, result) }))
    .filter((entry) => entry.valid).sort((left, right) => right.score - left.score);
  const selected = ranked[0]?.result;
  if (!selected) return { status: "no_strict_match" };
  await new Promise((resolve) => setTimeout(resolve, 350));
  const detailResponse = await fetch(`https://api.deezer.com/track/${selected.id}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!detailResponse.ok) throw new Error(`Deezer track lookup returned ${detailResponse.status}`);
  const detail = await detailResponse.json();
  if (detail.error) throw new Error(`Deezer track error ${detail.error.code}: ${detail.error.message}`);
  const releaseYear = Number(String(detail.release_date ?? "").slice(0, 4));
  if (!Number.isInteger(releaseYear) || releaseYear < 1900 || releaseYear > 2026) {
    return { status: "missing_release_year" };
  }
  return {
    status: "matched",
    source: "deezer",
    trackId: detail.id,
    trackName: detail.title_short ?? detail.title,
    artistName: detail.artist?.name,
    artists: [...new Set((detail.contributors ?? []).map((artist) => artist.name).filter(Boolean))],
    albumName: detail.album?.title,
    releaseYear,
    genre: "Unclassified",
    durationMs: Math.round(Number(detail.duration) * 1000),
    artworkUrl: detail.album?.cover_xl ?? detail.album?.cover_big,
    trackUrl: detail.link ?? null,
    previewUrl: detail.preview ?? null,
  };
}

let itunesBlocked = false;
async function canonicalMetadata(row) {
  const cacheFile = path.join(cacheDirectory, `${row.sourceRank}-${slug(`${row.artist}-${row.title}`)}.json`);
  if (existsSync(cacheFile) && !refresh) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (metadataAcceptable(row, cached)) return cached;
  }
  let metadata;
  if (!itunesBlocked) {
    try {
      metadata = await searchItunes(row);
    } catch (error) {
      if (/returned (?:403|429)/u.test(error.message)) itunesBlocked = true;
      else throw error;
    }
  }
  if (!metadata || metadata.status !== "matched") metadata = await searchDeezer(row);
  writeFileSync(cacheFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 350));
  return metadata;
}

function featuredArtists(title) {
  const text = title.match(/\((?:feat(?:uring)?|ft|with)\.?\s*([^)]+)\)/iu)?.[1] ?? "";
  return text.split(/\s*(?:,|&|\band\b)\s*/iu).map((artist) => artist.trim()).filter(Boolean);
}

function completeArtists(row, metadata) {
  const result = [row.artist, ...featuredArtists(row.title), ...featuredArtists(metadata.trackName ?? "")];
  if (metadata.source !== "deezer") {
    const remainder = String(metadata.artistName ?? "").replace(new RegExp(`^${row.artist.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*`, "iu"), "")
      .replace(/^\s*(?:,|&|feat\.?|with)\s*/iu, "");
    if (remainder) result.push(...remainder.split(/\s*(?:,|&|\bfeat\.?\b|\bwith\b)\s*/iu));
  }
  return [...new Map(result.map((artist) => [normalize(artist), artist.trim()])).values()].filter(Boolean);
}

function scoresFor(row, year) {
  const billions = Number(String(row.displayedStreams ?? "1B").match(/[0-9.]+/u)?.[0] ?? 1);
  const reach = Math.round(55 + (Math.log10(Math.min(5.5, Math.max(1, billions))) / Math.log10(5.5)) * 45);
  const age = 2026 - year;
  const longevity = age >= 20 ? 92 : age >= 12 ? 85 : age >= 7 ? 78 : age >= 3 ? 68 : 55;
  const current = year >= 2024 ? 90 : year >= 2020 ? 82 : year >= 2010 ? 72 : 65;
  const audience = Math.min(96, Math.max(72, Math.round(reach * 0.9)));
  return { audienceRecognition: audience, currentCirculation: current, broaderVisibility: reach, longevity };
}

function familiarityFor(scores) {
  return Math.round(scores.audienceRecognition * 0.4 + scores.currentCirculation * 0.25
    + scores.broaderVisibility * 0.2 + scores.longevity * 0.15);
}

function newCandidate(row, metadata, usedIds) {
  const title = metadata.trackName;
  const lead = row.artist;
  const primaryArtists = completeArtists(row, metadata);
  let id = slug(`${lead}-${baseTitle(title)}`);
  let suffix = 2;
  while (usedIds.has(id)) id = `${slug(`${lead}-${baseTitle(title)}`)}-${suffix++}`;
  usedIds.add(id);
  const scores = scoresFor(row, metadata.releaseYear);
  const language = row.languageReview === "english" ? "en"
    : row.languageReview === "multilingual" ? "mul"
      : "und";
  return {
    id,
    title,
    artist: primaryArtists.join(" & "),
    primaryArtists,
    aliases: normalize(title) === normalize(row.title) ? [] : [row.title],
    artistAliases: [],
    releaseYear: metadata.releaseYear,
    genres: [metadata.genre.toLowerCase()],
    language,
    bucket: "billion_anchor",
    selectionSignals: ["billion_streams"],
    scores,
    familiarity: familiarityFor(scores),
    introRecognition: null,
    easeScore: null,
    proposedDifficulty: null,
    difficultyOverrideReason: null,
    reviewStatus: "needs_media",
    media: {
      audioFile: `${id}.mp3`,
      artworkFile: `${id}.jpg`,
      artworkUrl: metadata.artworkUrl,
      artworkStatus: "verified_itunes_album_art_needs_r2",
    },
    startAtMs: 30,
    album: metadata.albumName,
    itunesTrackUrl: metadata.trackUrl,
    itunesDurationMs: metadata.durationMs,
    metadataStatus: metadata.source === "deezer" ? "verified_deezer_search" : "verified_itunes_search",
    metadataProvider: metadata.source ?? "itunes",
  };
}

const activeBillion = longlist.tracks.filter((row) => row.signals?.includes("billion_streams"));
const rows = activeBillion.map((row) => ({ row, candidate: candidateFor(row) }));
const existing = rows.filter(({ candidate }) => candidate && !catalogIds.has(candidate.id)
  && candidate.reviewStatus !== "rejected");
const uniqueExisting = [...new Map(existing.map((entry) => [entry.candidate.id, entry])).values()];
const selected = uniqueExisting.slice(0, target).map(({ row, candidate }) => ({
  sourceRank: row.sourceRank,
  displayedStreams: row.displayedStreams,
  id: candidate.id,
  title: candidate.title,
  artist: candidate.artist,
  origin: "existing_candidate",
}));

const usedIds = new Set(candidateRoot.songs.map((song) => song.id));
const additions = [];
const metadataUpdates = [];
const skipped = [];
if (refreshExisting) {
  for (const entry of selected) {
    const source = rows.find(({ row }) => row.sourceRank === entry.sourceRank);
    const candidate = candidateRoot.songs.find((song) => song.id === entry.id);
    if (!source || !candidate) continue;
    try {
      const metadata = await canonicalMetadata(source.row);
      if (metadata.status !== "matched") {
        skipped.push({ sourceRank: source.row.sourceRank, title: source.row.title, artist: source.row.artist, reason: `existing_${metadata.status}` });
        continue;
      }
      metadataUpdates.push({
        id: candidate.id,
        album: metadata.albumName,
        artworkUrl: metadata.artworkUrl,
        durationMs: metadata.durationMs,
        trackUrl: metadata.trackUrl,
        provider: metadata.source ?? "itunes",
      });
    } catch (error) {
      skipped.push({ sourceRank: source.row.sourceRank, title: source.row.title, artist: source.row.artist, reason: `existing_${error.message}` });
    }
  }
}
for (const { row, candidate } of rows) {
  if (selected.length >= target) break;
  if (candidate) continue;
  if (row.languageReview === "non_english") {
    skipped.push({ sourceRank: row.sourceRank, title: row.title, artist: row.artist, reason: "explicitly_non_english" });
    continue;
  }
  if (row.languageReview === "multilingual" && baseTitle(row.title) !== "hips don t lie") {
    skipped.push({ sourceRank: row.sourceRank, title: row.title, artist: row.artist, reason: "multilingual_not_preapproved" });
    continue;
  }
  try {
    const metadata = await canonicalMetadata(row);
    if (metadata.status !== "matched") {
      skipped.push({ sourceRank: row.sourceRank, title: row.title, artist: row.artist, reason: metadata.status });
      continue;
    }
    const candidateRecord = newCandidate(row, metadata, usedIds);
    additions.push(candidateRecord);
    selected.push({
      sourceRank: row.sourceRank,
      displayedStreams: row.displayedStreams,
      id: candidateRecord.id,
      title: candidateRecord.title,
      artist: candidateRecord.artist,
      origin: "new_candidate",
    });
    console.log(`MATCH #${row.sourceRank} ${candidateRecord.title} — ${candidateRecord.artist}`);
  } catch (error) {
    skipped.push({ sourceRank: row.sourceRank, title: row.title, artist: row.artist, reason: error.message });
    console.warn(`SKIP #${row.sourceRank} ${row.title}: ${error.message}`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  target,
  selectedCount: selected.length,
  existingCandidateCount: selected.filter((entry) => entry.origin === "existing_candidate").length,
  newCandidateCount: additions.length,
  metadataUpdateCount: metadataUpdates.length,
  selected,
  skipped,
};
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\nBatch selected: ${selected.length}/${target}; existing=${report.existingCandidateCount}; new=${additions.length}; skipped=${skipped.length}.`);
console.log(`Report: ${path.relative(root, reportFile)}`);
if (selected.length !== target) throw new Error(`Could not prepare the requested ${target}-song batch.`);
if (apply) {
  candidateRoot.songs.push(...additions);
  for (const update of metadataUpdates) {
    const candidate = candidateRoot.songs.find((song) => song.id === update.id);
    if (!candidate) continue;
    candidate.album = update.album;
    candidate.media.artworkUrl = update.artworkUrl;
    candidate.media.artworkStatus = `${update.provider === "deezer" ? "verified_deezer" : "verified_itunes"}_album_art_needs_r2`;
    candidate.itunesDurationMs = update.durationMs;
    candidate.itunesTrackUrl = update.trackUrl;
    candidate.metadataStatus = update.provider === "deezer" ? "verified_deezer_search" : "verified_itunes_search";
    candidate.metadataProvider = update.provider;
  }
  writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
  console.log(`Applied ${additions.length} new candidates and ${metadataUpdates.length} metadata refreshes to data/song-candidates.json.`);
} else {
  console.log("[DRY RUN] Candidate records were not changed. Repeat with --apply after reviewing the report.");
}
