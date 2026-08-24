import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const cacheDirectory = path.join(root, "data", "spotify-track-pages.local");
const reportFile = path.join(root, "data", "spotify-track-page-audit.local.json");
const refresh = process.argv.includes("--refresh");
const cachedOnly = process.argv.includes("--cached-only");
const applyMetadata = process.argv.includes("--apply-metadata");
const selectedIds = new Set(
  (process.argv.find((value) => value.startsWith("--id="))?.split("=")[1] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);
const concurrency = Math.max(1, Math.min(10, Number(
  process.argv.find((value) => value.startsWith("--concurrency="))?.split("=")[1] ?? 6,
)));

mkdirSync(cacheDirectory, { recursive: true });
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const songs = candidateRoot.songs.filter((song) => (
  song.media?.hostedFullUrl
  && /^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+/u.test(song.spotifyUrl ?? "")
  && (selectedIds.size === 0 || selectedIds.has(song.id))
));

function decodeHtml(value = "") {
  return value
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gu, "&").replace(/&quot;/gu, '"').replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">");
}

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsPhrase(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)=(?:"([^"]*)"|'([^']*)')/gu)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? "");
  }
  return result;
}

function parsePage(html, url) {
  const meta = new Map();
  for (const tag of html.match(/<meta\s+[^>]*>/giu) ?? []) {
    const values = attributes(tag);
    const key = values.property ?? values.name;
    if (!key || values.content === undefined) continue;
    const entries = meta.get(key) ?? [];
    entries.push(values.content);
    meta.set(key, entries);
  }
  const description = meta.get("og:description")?.[0] ?? "";
  const descriptionParts = description.split(" · ").map((value) => value.trim());
  const songIndex = descriptionParts.findIndex((value) => normalize(value) === "song");
  const durationSeconds = Number(meta.get("music:duration")?.[0]);
  const musicianDescriptions = meta.get("music:musician_description") ?? [];
  return {
    url,
    title: meta.get("og:title")?.[0] ?? meta.get("twitter:title")?.[0] ?? null,
    description,
    displayArtist: descriptionParts[0] ?? null,
    artists: [...new Set((musicianDescriptions.length > 0
      ? musicianDescriptions
      : descriptionParts.slice(0, 1)).filter(Boolean))],
    album: songIndex >= 1 ? descriptionParts[songIndex - 1] : null,
    releaseYear: Number(descriptionParts[songIndex + 1]) || null,
    releaseDate: meta.get("music:release_date")?.[0] ?? null,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 60 ? durationSeconds : null,
    artworkUrl: meta.get("og:image")?.[0] ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchPage(song) {
  const cacheFile = path.join(cacheDirectory, `${song.id}.json`);
  if (!refresh && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  if (cachedOnly) throw new Error("Spotify public page is not cached yet");
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(song.spotifyUrl, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; SonglessMetadataAudit/1.0)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Spotify public page returned ${response.status}`);
      const page = parsePage(await response.text(), song.spotifyUrl);
      writeFileSync(cacheFile, `${JSON.stringify(page, null, 2)}\n`, "utf8");
      return page;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function inspect(song, page) {
  const titleOptions = [song.title, ...(song.aliases ?? [])].map(normalize);
  const spotifyTitle = normalize(page.title ?? "");
  const matchedTitle = titleOptions.find((title) => spotifyTitle === title || containsPhrase(spotifyTitle, title));
  const versionText = matchedTitle ? spotifyTitle.replace(matchedTitle, "").trim() : spotifyTitle;
  const altered = /\b(live|acoustic|stripped|orchestral|lullaby|animatic|footnotes|remix|mix|dub|medley|sped|slowed|reverb|nightcore|cover|karaoke|instrumental|clean|radio edit|extended|editions?|re[- ]?recorded|rerecorded|remake|w(?:\/|\s)?o|without|demo|tribute|making of|footnotes|behind the scenes?|documentary|visuals?|visuali[sz]er)\b/iu.test(versionText);
  const descriptionArtist = page.displayArtist ?? page.description?.split(" · ")[0] ?? "";
  const spotifyArtists = [...new Set((page.artists ?? []).filter(Boolean))];
  const artistText = normalize(descriptionArtist);
  const creditedArtists = song.primaryArtists.map(normalize);
  const artistCoverage = creditedArtists.filter((artist) => containsPhrase(artistText, artist));
  const titleMatch = Boolean(matchedTitle) && !altered;
  const artistFingerprint = (value) => normalize(value).replace(/\band\b/gu, "").replace(/\s+/gu, "");
  const expectedArtistFingerprint = artistFingerprint(song.primaryArtists.join(" "));
  const spotifyArtistFingerprint = artistFingerprint(descriptionArtist);
  const artistMatch = artistCoverage.length === creditedArtists.length;
  const completeArtistMatch = artistMatch && expectedArtistFingerprint === spotifyArtistFingerprint;
  const durationSeconds = page.durationSeconds;
  const hostedDurationSeconds = Number(song.media.hostedDurationMs) / 1000;
  const deltaSeconds = Number.isFinite(durationSeconds) && Number.isFinite(hostedDurationSeconds)
    ? Number((hostedDurationSeconds - durationSeconds).toFixed(3))
    : null;
  const valid = titleMatch && artistMatch && Number.isFinite(durationSeconds);
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    spotifyUrl: song.spotifyUrl,
    spotifyTitle: page.title,
    spotifyArtists,
    spotifyDisplayArtist: descriptionArtist,
    spotifyAlbum: page.album,
    spotifyReleaseYear: page.releaseYear,
    spotifyDurationSeconds: durationSeconds,
    hostedDurationSeconds,
    deltaSeconds,
    titleMatch,
    artistCoverage: artistCoverage.length,
    expectedArtistCount: creditedArtists.length,
    completeArtistMatch,
    valid,
    flags: [
      ...(!titleMatch ? ["spotify-title-or-version-mismatch"] : []),
      ...(!artistMatch ? ["spotify-artist-mismatch"] : []),
      ...(artistMatch && !completeArtistMatch ? ["spotify-extra-artist-credit"] : []),
      ...(!Number.isFinite(durationSeconds) ? ["spotify-duration-missing"] : []),
      ...(valid && Math.abs(deltaSeconds) > 4 ? ["hosted-duration-mismatch"] : []),
    ],
  };
}

const reports = [];
let cursor = 0;
async function worker() {
  while (cursor < songs.length) {
    const song = songs[cursor++];
    try {
      const report = inspect(song, await fetchPage(song));
      reports.push(report);
      console.log(`${report.flags.length ? "FLAG" : "PASS"} ${song.id}${report.flags.length ? `: ${report.flags.join(", ")}` : ""}`);
      if (applyMetadata && report.valid && report.completeArtistMatch) {
        if (report.spotifyAlbum) song.album = report.spotifyAlbum;
        song.spotifyDurationMs = Math.round(report.spotifyDurationSeconds * 1000);
        song.spotifyMetadataStatus = "verified_public_page";
      }
    } catch (error) {
      reports.push({ id: song.id, title: song.title, artist: song.artist, valid: false, flags: ["spotify-page-error"], error: error.message });
      console.error(`FAIL ${song.id}: ${error.message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, songs.length) }, () => worker()));
reports.sort((left, right) => left.id.localeCompare(right.id));
const flagCounts = {};
for (const report of reports) for (const flag of report.flags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
writeFileSync(reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), songs: reports, flagCounts }, null, 2)}\n`, "utf8");
if (applyMetadata) writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`\nSpotify public pages audited: ${reports.length}; exact valid matches: ${reports.filter((report) => report.valid).length}.`);
for (const [flag, count] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) console.log(`${flag}: ${count}`);
console.log(`Report: ${path.relative(root, reportFile)}`);
