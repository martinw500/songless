import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const preparedDirectory = path.join(root, "private-media", "r2", "full");
const cacheDirectory = path.join(root, "data", "deezer-track-metadata.local");
const reportFile = path.join(root, "data", "deezer-metadata-audit.local.json");
const refresh = process.argv.includes("--refresh");
const verbose = process.argv.includes("--verbose");
const selectedIds = new Set(
  (process.argv.find((value) => value.startsWith("--id="))?.split("=")[1] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);
const limit = Number(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] ?? Number.POSITIVE_INFINITY);

mkdirSync(cacheDirectory, { recursive: true });
const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs
  .filter((song) => (song.media?.hostedFullUrl || existsSync(path.join(preparedDirectory, `${song.id}.mp3`)))
    && (selectedIds.size === 0 || selectedIds.has(song.id)));

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsPhrase(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

function normalizeArtist(value = "") {
  return normalize(value).replace(/^(?:the|ms)\s+/u, "");
}

const altered = /\b(live|concert|sessions?|acoustic|stripped|remix|mix|disko|sped|slowed|reverb|nightcore|cover|karaoke|instrumental|clean|radio (?:edit|version)|versions?|extended|re recorded|rerecorded|remake|mashup|parody|demo|tribute|sprint music series|taylor s version|originally performed|made famous|in the style of|midifine|unplugged|megamix|432\s*hz|8\s*d|3\s*d|10\s*d|7000\s*d|pitched)\b/iu;
const rejectedAlbum = /\b(?:unplugged|megamix|workout|fitness|body by|karaoke|sing.?along|greatest hits|best of|essentials|party hits)\b/iu;

function inspect(candidate, result) {
  const titles = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const title = normalize(result.title ?? "");
  const titleShort = normalize(result.title_short ?? result.title ?? "");
  const exactTitle = titles.includes(titleShort) || titles.includes(title);
  const titleMatch = exactTitle || titles.some((option) => containsPhrase(title, option) || containsPhrase(option, titleShort));
  const versionText = title.replace(titles.find((option) => containsPhrase(title, option)) ?? "", " ");
  const credits = normalize([
    result.artist?.name,
    ...(result.contributors ?? []).map((artist) => artist.name),
    result.title,
  ].filter(Boolean).join(" "));
  const artists = candidate.primaryArtists.map(normalize);
  const artistCoverage = artists.filter((artist) => containsPhrase(credits, artist)).length;
  const leadMatch = normalizeArtist(result.artist?.name ?? "") === normalizeArtist(candidate.primaryArtists[0] ?? "");
  const expectedAlbum = normalize(candidate.album ?? "");
  const album = normalize(result.album?.title ?? "");
  const alteredAlbum = altered.test(album) || rejectedAlbum.test(album);
  const albumMatch = expectedAlbum && (album === expectedAlbum
    || containsPhrase(album, expectedAlbum) || containsPhrase(expectedAlbum, album));
  const spotifyDurationSeconds = Number(candidate.spotifyDurationMs) / 1000;
  const referenceDurationSeconds = Number.isFinite(spotifyDurationSeconds) && spotifyDurationSeconds > 0
    ? spotifyDurationSeconds
    : null;
  const durationDifference = referenceDurationSeconds === null
    ? null
    : Math.abs(Number(result.duration) - referenceDurationSeconds);
  const spotifyCorroborated = candidate.spotifyMetadataStatus === "verified_public_page"
    && exactTitle && leadMatch && durationDifference !== null && durationDifference <= 2;
  const creditsVerified = artistCoverage === artists.length
    || (artists.length === 1 && leadMatch)
    || spotifyCorroborated;
  const albumRequired = Boolean(expectedAlbum);
  const valid = (referenceDurationSeconds === null ? exactTitle : titleMatch) && leadMatch && creditsVerified
    && !altered.test(versionText)
    && !alteredAlbum
    && (!albumRequired || albumMatch)
    && Number.isFinite(Number(result.duration)) && result.duration >= 60
    && (durationDifference === null || durationDifference <= 15)
    && /^https:\/\//u.test(result.preview ?? "");
  const score = (exactTitle ? 500 : titleMatch ? 250 : -500)
    + artistCoverage * 200
    + (leadMatch ? 100 : 0)
    + (albumMatch ? 250 : 0)
    + (durationDifference !== null ? Math.max(-200, 150 - durationDifference * 40) : 0)
    - (altered.test(versionText) ? 800 : 0)
    - (alteredAlbum ? 800 : 0);
  return { valid, score, artistCoverage, albumMatch, durationDifference, spotifyCorroborated };
}

const report = { generatedAt: new Date().toISOString(), songs: [] };
let requests = 0;
for (const candidate of candidates) {
  if (requests >= limit) break;
  const cacheFile = path.join(cacheDirectory, `${candidate.id}.json`);
  if (existsSync(cacheFile) && !refresh) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    report.songs.push({ id: candidate.id, status: cached?.status ?? "matched", cached: true });
    continue;
  }
  requests += 1;
  try {
    const query = encodeURIComponent(`${candidate.title} ${candidate.primaryArtists.join(" ")}`);
    const response = await fetch(`https://api.deezer.com/search?q=${query}&limit=50`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Deezer search returned ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`Deezer API error ${payload.error.code}: ${payload.error.message}`);
    let results = payload.data ?? [];
    let ranked = results.map((result) => ({ result, ...inspect(candidate, result) }))
      .filter((entry) => entry.valid)
      .sort((left, right) => right.score - left.score);
    if (ranked.length === 0 && candidate.album) {
      const albumHint = candidate.album.split(",")[0].trim().split(/\s+/u).slice(0, 8).join(" ");
      const albumQuery = encodeURIComponent(`${candidate.title} ${albumHint} ${candidate.primaryArtists[0]}`);
      const albumResponse = await fetch(`https://api.deezer.com/search?q=${albumQuery}&limit=50`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!albumResponse.ok) throw new Error(`Deezer album search returned ${albumResponse.status}`);
      const albumPayload = await albumResponse.json();
      if (albumPayload.error) throw new Error(`Deezer API error ${albumPayload.error.code}: ${albumPayload.error.message}`);
      const seen = new Set(results.map((result) => result.id));
      results = [...results, ...(albumPayload.data ?? []).filter((result) => !seen.has(result.id))];
      ranked = results.map((result) => ({ result, ...inspect(candidate, result) }))
        .filter((entry) => entry.valid)
        .sort((left, right) => right.score - left.score);
    }
    if (verbose && ranked.length === 0) {
      for (const result of results.slice(0, 10)) {
        const verdict = inspect(candidate, result);
        console.log(`  REJECT ${result.title} — ${result.artist?.name}: ${JSON.stringify(verdict)}`);
      }
    }
    const selected = ranked[0];
    const metadata = selected ? {
      schemaVersion: 1,
      status: "matched",
      trackId: selected.result.id,
      trackName: selected.result.title_short ?? selected.result.title,
      displayTitle: selected.result.title,
      artistName: selected.result.artist?.name ?? null,
      contributors: (selected.result.contributors ?? []).map((artist) => artist.name),
      albumName: selected.result.album?.title ?? null,
      durationSeconds: Number(selected.result.duration),
      previewUrl: selected.result.preview,
      trackUrl: selected.result.link ?? null,
      score: Math.round(selected.score),
      creditEvidence: selected.spotifyCorroborated ? "verified_spotify_public_page" : "deezer_complete_credits",
    } : { schemaVersion: 1, status: "no_match" };
    writeFileSync(cacheFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    report.songs.push({ id: candidate.id, status: metadata.status, cached: false });
    console.log(`${metadata.status === "matched" ? "MATCH" : "REVIEW"} ${candidate.id}${selected ? `: ${metadata.trackName} — ${metadata.artistName} (${metadata.durationSeconds}s)` : ""}`);
  } catch (error) {
    report.songs.push({ id: candidate.id, status: "error", error: error.message, cached: false });
    console.error(`ERROR ${candidate.id}: ${error.message}`);
  }
}

writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const counts = Object.groupBy(report.songs, (song) => song.status);
console.log(`Deezer metadata: ${report.songs.length} song(s); ${Object.entries(counts).map(([key, rows]) => `${key}=${rows.length}`).join(", ")}; requests=${requests}.`);
console.log(`Report: ${path.relative(root, reportFile)}`);
