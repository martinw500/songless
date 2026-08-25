import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const sourceFile = path.join(root, "data", "song-download-sources.local.json");
const cacheDirectory = path.join(root, "data", "studio-source-search.local");
const metadataCacheDirectory = path.join(root, "data", "itunes-track-metadata.local");
const preparedDirectory = path.join(root, "private-media", "r2", "full");
const reportFile = path.join(root, "data", "studio-source-audit.local.json");
const fingerprintReportFile = path.join(root, "data", "canonical-fingerprint-audit.local.json");
const apply = process.argv.includes("--apply");
const forceSearch = process.argv.includes("--force-search");
const refreshMetadata = process.argv.includes("--refresh-metadata");
const metadataOnly = process.argv.includes("--metadata-only");
const auditOnly = process.argv.includes("--audit-only");
const metadataRequestLimit = Number(
  process.argv.find((value) => value.startsWith("--metadata-request-limit="))?.split("=")[1]
    ?? Number.POSITIVE_INFINITY,
);
const verbose = process.argv.includes("--verbose");
const selectedIds = new Set(
  (process.argv.find((value) => value.startsWith("--id="))?.split("=")[1] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const limit = Number(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] ?? Number.POSITIVE_INFINITY);
const searchSize = Math.max(10, Math.min(50, Number(
  process.argv.find((value) => value.startsWith("--search-size="))?.split("=")[1] ?? 30,
)));
let metadataRequests = 0;

mkdirSync(cacheDirectory, { recursive: true });
mkdirSync(metadataCacheDirectory, { recursive: true });
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const playable = candidateRoot.songs.filter((song) => (song.media?.hostedFullUrl && song.media?.hostedClueUrl)
  || existsSync(path.join(preparedDirectory, `${song.id}.mp3`)));
const sourceRoot = JSON.parse(readFileSync(sourceFile, "utf8"));
const sourceById = new Map(sourceRoot.songs.map((source) => [source.id, source]));
const fingerprintRoot = existsSync(fingerprintReportFile)
  ? JSON.parse(readFileSync(fingerprintReportFile, "utf8"))
  : { songs: [] };
const fingerprintById = new Map(fingerprintRoot.songs.map((song) => [song.id, song]));

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function compact(value) {
  return normalize(value).replace(/\s+/gu, "");
}

function containsPhrase(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

const rejected = /\b(live|concert|performance|sessions?|acoustic|stripped|orchestral|lullaby|animatic|footnotes|a ?cappella|acapella|remix|mix(?:ed)?|dub|medley|sped|slowed|reverb|nightcore|cover|karaoke|instrumental|clean|radio (?:edit|mix)|extended|edit|editions?|versions?|re[- ]?recorded|rerecorded|remake|harder|w(?:\/|\s)?o|without|loop|reaction|bass boosted|8d|mashup|parody|tutorial|snippet|teaser|demo|unreleased|fan made|shorts|compilation|interview|explained|breakdown|making of|behind the scenes?|documentary|vocals only|music only|music video|official video|visuals?|visuali[sz]er)\b/iu;

function inspect(candidate, result, canonicalEvidence = null) {
  const title = result.title ?? "";
  const channel = result.channel ?? result.uploader ?? "";
  const description = result.description ?? "";
  const canonicalDurationSeconds = canonicalEvidence?.durationSeconds ?? null;
  if (!Number.isFinite(canonicalDurationSeconds)) {
    return { accepted: false, reason: "missing-canonical-edition-evidence", score: -1 };
  }
  const normalizedTitle = normalize(title);
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const matchedTitle = titleOptions.find((option) => containsPhrase(normalizedTitle, option));
  if (!matchedTitle) return { accepted: false, reason: "title-mismatch", score: -1 };
  // Work from normalized text so punctuation/case differences cannot leave the
  // candidate's own "feat." or "Taylor's Version" suffix behind as a false
  // altered-version signal.
  const versionText = normalizedTitle.replace(matchedTitle, "").trim();
  const isLyricVideo = /\blyric(?:s)?\b.*\bvideo\b/iu.test(title);
  const isOfficialVideo = /\bofficial\b.*\bvideo\b/iu.test(title) && !isLyricVideo;
  const hasVideoLabel = /\bvideo\b/iu.test(title);
  const isVisualizer = /\bvisuali[sz]er\b/iu.test(title);
  const channelNamesLeadArtist = candidate.primaryArtists.some((artist) => (
    containsPhrase(normalize(channel), normalize(artist))
    || compact(channel).includes(compact(artist))
  ));
  const verifiedArtistLyricVideo = hasVideoLabel
    && isLyricVideo
    && Boolean(result.channel_is_verified)
    && channelNamesLeadArtist;
  const verifiedArtistVisualizer = isVisualizer
    && Boolean(result.channel_is_verified)
    && channelNamesLeadArtist
    && Math.abs(result.duration - canonicalDurationSeconds) <= 2.5;
  if ((rejected.test(versionText) && !verifiedArtistVisualizer)
    || (/\s\/\s/u.test(title) && !candidate.title.includes("/"))
    || /\bmusic\s+video\b/iu.test(title)
    || isOfficialVideo
    || (hasVideoLabel && !verifiedArtistLyricVideo)) {
    return { accepted: false, reason: "altered-or-video-version", score: -1 };
  }
  const namesUnexpectedCollaborator = /\b(?:feat(?:uring)?|ft|with)\b/iu.test(versionText)
    && (candidate.primaryArtists.length === 1
      || candidate.primaryArtists.slice(1).some((artist) => !containsPhrase(normalizedTitle, normalize(artist))));
  if (namesUnexpectedCollaborator) {
    return { accepted: false, reason: "unexpected-collaborator", score: -1 };
  }
  if (!Number.isFinite(result.duration) || result.duration < 75 || result.duration > 720) {
    return { accepted: false, reason: "invalid-duration", score: -1 };
  }
  if (Number.isFinite(canonicalDurationSeconds) && Math.abs(result.duration - canonicalDurationSeconds) > 2.5) {
    return { accepted: false, reason: "canonical-duration-mismatch", score: -1 };
  }

  const artists = candidate.primaryArtists.map(normalize);
  const artistAliases = (candidate.artistAliases ?? []).map(normalize);
  const normalizedChannel = normalize(channel);
  const compactChannel = compact(channel);
  if (/\b(karaoke|tribute|cover|remix)\b/iu.test(normalizedChannel)) {
    return { accepted: false, reason: "non-artist-topic-channel", score: -1 };
  }
  const knownArtists = [...artists, ...artistAliases];
  const artistInChannel = knownArtists.some((artist) => (
    containsPhrase(normalizedChannel, artist)
    || (compact(artist).length >= 3 && compactChannel.includes(compact(artist)))
  ));
  const leadArtistInChannel = containsPhrase(normalizedChannel, artists[0] ?? "")
    || (compact(artists[0] ?? "").length >= 3 && compactChannel.includes(compact(artists[0] ?? "")));
  const artistCoverage = artists.filter((artist) => containsPhrase(`${normalizedTitle} ${normalizedChannel}`, artist));
  if (!artistInChannel && artistCoverage.length === 0) return { accepted: false, reason: "artist-mismatch", score: -1 };
  const titleIndex = normalizedTitle.indexOf(matchedTitle);
  let unclaimedPrefix = titleIndex > 0 ? normalizedTitle.slice(0, titleIndex) : "";
  for (const artist of knownArtists) unclaimedPrefix = unclaimedPrefix.replaceAll(artist, " ");
  unclaimedPrefix = unclaimedPrefix.replace(/\b(?:official|audio|lyrics?|hq|flac)\b/gu, " ").replace(/\s+/gu, " ").trim();
  if (unclaimedPrefix && !artistInChannel) {
    return { accepted: false, reason: "unexpected-prefix-credit", score: -1 };
  }
  const verifiedLeadRelease = artists.length > 1
    && artistCoverage.length >= 1
    && Boolean(result.channel_is_verified)
    && leadArtistInChannel
    && Number.isFinite(canonicalDurationSeconds)
    && Math.abs(result.duration - canonicalDurationSeconds) <= 2.5;
  if (artists.length > 1 && artistCoverage.length < artists.length && !verifiedLeadRelease) {
    return { accepted: false, reason: "incomplete-artist-credits", score: -1 };
  }

  const isTopic = knownArtists.some((artist) => normalizedChannel === `${artist} topic`);
  const explicitAudio = /\b(?:official )?audio(?: only)?\b/iu.test(title);
  const officialLyrics = /\bofficial lyric(?:s| video)?\b/iu.test(title);
  const isVevo = /vevo/iu.test(channel);
  const normalizedDescription = normalize(description);
  const providedToYouTube = /\bprovided to youtube\b/iu.test(description);
  const canonicalAlbum = normalize(canonicalEvidence?.album ?? "");
  const canonicalYear = Number(canonicalEvidence?.releaseYear);
  const descriptionAlbumMatch = canonicalAlbum.length >= 3 && containsPhrase(normalizedDescription, canonicalAlbum);
  const descriptionYearMatch = Number.isInteger(canonicalYear)
    && containsPhrase(normalizedDescription, String(canonicalYear));
  if (providedToYouTube && canonicalAlbum && !descriptionAlbumMatch && !descriptionYearMatch) {
    return { accepted: false, reason: "topic-release-metadata-mismatch", score: -1 };
  }
  const verifiedArtistAudio = Boolean(result.channel_is_verified) && artistInChannel && explicitAudio;
  const durationVerifiedMirror = Number.isFinite(canonicalDurationSeconds)
    && Math.abs(result.duration - canonicalDurationSeconds) <= 2.5
    && artistCoverage.length === artists.length
    && (explicitAudio || /\b(?:hq|lyrics?)\b/iu.test(title) || /\bsub\s+espa(?:ñ|n)ol\b/iu.test(title));
  const verifiedArtistRelease = Boolean(result.channel_is_verified)
    && artistInChannel
    && providedToYouTube
    && (descriptionAlbumMatch || descriptionYearMatch)
    && (normalize(title) === normalize(candidate.title)
      || titleOptions.some((option) => containsPhrase(normalizedTitle, option)));
  if (!(isTopic && artistInChannel)
    && !(explicitAudio && artistInChannel)
    && !(officialLyrics && (artistInChannel || isVevo))
    && !verifiedArtistAudio
    && !verifiedArtistLyricVideo
    && !verifiedArtistVisualizer
    && !verifiedArtistRelease
    && !verifiedLeadRelease
    && !durationVerifiedMirror) {
    return { accepted: false, reason: "not-studio-audio-provenance", score: -1 };
  }

  let score = 0;
  if (isTopic && artistInChannel) score += 600;
  if (verifiedArtistAudio) score += 500;
  if (verifiedArtistLyricVideo) score += 500;
  if (verifiedArtistVisualizer) score += 500;
  if (explicitAudio && artistInChannel) score += 400;
  if (officialLyrics && (artistInChannel || isVevo)) score += 220;
  if (verifiedArtistRelease) score += 360;
  if (verifiedLeadRelease) score += 320;
  if (durationVerifiedMirror) score += 120;
  if (result.channel_is_verified) score += 80;
  if (normalize(title) === normalize(candidate.title)) score += 180;
  score += artistCoverage.length * 40;
  const expectedSeconds = canonicalDurationSeconds ?? candidate.media?.hostedDurationMs / 1000;
  if (Number.isFinite(expectedSeconds)) score += Math.max(0, 60 - Math.abs(result.duration - expectedSeconds));
  // An exact duration is useful corroboration, but it does not prove that a
  // third-party lyrics mirror contains the canonical studio master. Keep
  // those results visible for manual review instead of auto-selecting them.
  if (score < 500) {
    return { accepted: false, reason: "low-confidence-third-party-mirror", score };
  }
  return { accepted: true, reason: "strict-studio-audio", score };
}

function cachedMetadataMatchesCandidate(candidate, metadata) {
  if (!metadata || !Number.isFinite(metadata.durationSeconds)
    || metadata.durationSeconds < 75 || metadata.durationSeconds > 720) return false;
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const cachedTitle = normalize(metadata.trackName ?? "");
  const leadArtist = normalize(candidate.primaryArtists[0] ?? "");
  const cachedArtist = normalize(metadata.artistName ?? "");
  const cachedCredits = normalize(`${metadata.artistName ?? ""} ${metadata.trackName ?? ""}`);
  const titleMatch = titleOptions.some((title) => containsPhrase(cachedTitle, title));
  const matchedTitle = titleOptions.find((title) => cachedTitle === title)
    ?? [...titleOptions].sort((left, right) => right.length - left.length)
      .find((title) => containsPhrase(cachedTitle, title));
  const leadArtistMatch = candidate.primaryArtists.length === 1
    ? cachedArtist === leadArtist
    : containsPhrase(cachedArtist, leadArtist);
  const completeArtistMatch = candidate.primaryArtists
    .map(normalize)
    .every((artist) => containsPhrase(cachedCredits, artist));
  const altered = rejected.test(cachedTitle.replace(matchedTitle ?? "", ""))
    || /\b(mixed|tribute|as made famous)\b/iu.test(cachedTitle);
  return titleMatch && leadArtistMatch && completeArtistMatch && !altered;
}

async function canonicalMetadata(candidate) {
  const cacheFile = path.join(metadataCacheDirectory, `${candidate.id}.json`);
  if (existsSync(cacheFile) && !refreshMetadata) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached === null) {
      const noMatch = { schemaVersion: 4, status: "no_match" };
      writeFileSync(cacheFile, `${JSON.stringify(noMatch, null, 2)}\n`, "utf8");
      return null;
    }
    if (cached?.schemaVersion === 4 && cached.status === "no_match") return null;
    if (cached?.schemaVersion === 4 && cachedMetadataMatchesCandidate(candidate, cached)) return cached;
    if ([2, 3].includes(cached?.schemaVersion) && cachedMetadataMatchesCandidate(candidate, cached)) {
      const upgraded = { ...cached, schemaVersion: 4 };
      writeFileSync(cacheFile, `${JSON.stringify(upgraded, null, 2)}\n`, "utf8");
      return upgraded;
    }
  }
  if (metadataRequests >= metadataRequestLimit) return null;
  if (verbose) console.log(`  METADATA REQUEST ${candidate.id}`);
  metadataRequests += 1;
  const leadArtistQuery = candidate.primaryArtists[0] ?? candidate.artist;
  const queryTerms = [...new Set([
    `${candidate.title} ${leadArtistQuery}`,
    `${candidate.title}`,
  ])];
  const searchResults = [];
  for (const country of ["CA", "US"]) {
    for (const term of queryTerms) {
      const query = encodeURIComponent(term);
      const response = await fetch(`https://itunes.apple.com/search?entity=song&country=${country}&limit=50&term=${query}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`iTunes metadata search returned ${response.status} (${country})`);
      const payload = await response.json();
      searchResults.push(...(payload.results ?? []));
    }
  }
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const artists = candidate.primaryArtists.map(normalize);
  const leadArtist = artists[0] ?? "";
  const expectedAlbum = normalize(candidate.album ?? "");
  const expectedYear = Number(candidate.releaseYear) || null;
  const ranked = searchResults.map((result) => {
    const resultTitle = normalize(result.trackName ?? "");
    const resultArtist = normalize(`${result.artistName ?? ""} ${result.trackName ?? ""}`);
    const resultArtistName = normalize(result.artistName ?? "");
    const resultAlbum = normalize(result.collectionName ?? "");
    const exactTitle = titleOptions.includes(resultTitle);
    const titleMatch = exactTitle || titleOptions.some((title) => containsPhrase(resultTitle, title));
    const matchedTitle = titleOptions.find((title) => resultTitle === title)
      ?? [...titleOptions].sort((left, right) => right.length - left.length)
        .find((title) => containsPhrase(resultTitle, title));
    const artistCoverage = artists.filter((artist) => containsPhrase(resultArtist, artist)).length;
    const altered = rejected.test(resultTitle.replace(matchedTitle ?? "", ""))
      || /\b(mixed|tribute|as made famous)\b/iu.test(resultTitle);
    const albumExact = expectedAlbum.length > 0 && resultAlbum === expectedAlbum;
    const albumMatch = albumExact || (expectedAlbum.length > 0
      && (containsPhrase(resultAlbum, expectedAlbum) || containsPhrase(expectedAlbum, resultAlbum)));
    const resultYear = Number(String(result.releaseDate ?? "").slice(0, 4)) || null;
    const yearDistance = expectedYear && resultYear ? Math.abs(expectedYear - resultYear) : null;
    const durationSeconds = Number(result.trackTimeMillis) / 1000;
    const validDuration = Number.isFinite(durationSeconds) && durationSeconds >= 75 && durationSeconds <= 720;
    const score = (exactTitle ? 500 : titleMatch ? 200 : -500)
      + artistCoverage * 180
      + (albumExact ? 400 : albumMatch ? 220 : 0)
      + (yearDistance === 0 ? 80 : yearDistance === 1 ? 40 : 0)
      - (yearDistance !== null && yearDistance > 5 ? 150 : 0)
      - (altered ? 600 : 0);
    const leadArtistMatch = artists.length === 1
      ? resultArtistName === leadArtist
      : containsPhrase(resultArtistName, leadArtist);
    return { result, score, artistCoverage, titleMatch, altered, validDuration, leadArtistMatch, albumMatch };
  }).filter((entry) => entry.titleMatch
    && entry.artistCoverage === artists.length
    && entry.leadArtistMatch
    && !entry.altered
    && entry.validDuration)
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0]?.result;
  const metadata = selected ? {
    schemaVersion: 4,
    durationSeconds: selected.trackTimeMillis / 1000,
    releaseYear: Number(String(selected.releaseDate ?? "").slice(0, 4)) || null,
    trackName: selected.trackName,
    artistName: selected.artistName,
    collectionName: selected.collectionName ?? null,
    trackId: selected.trackId ?? null,
    trackViewUrl: selected.trackViewUrl ?? null,
    previewUrl: selected.previewUrl ?? null,
  } : { schemaVersion: 4, status: "no_match" };
  writeFileSync(cacheFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return selected ? metadata : null;
}

function cachedSearch(candidate, canonicalEvidence) {
  const cacheFile = path.join(cacheDirectory, `${candidate.id}.json`);
  if (existsSync(cacheFile) && !forceSearch) return JSON.parse(readFileSync(cacheFile, "utf8"));
  const album = canonicalEvidence?.album ?? candidate.album ?? "";
  const query = `ytsearch${searchSize}:${candidate.artist} ${candidate.title} ${album} official audio topic`;
  const result = spawnSync("yt-dlp", [
    "--dump-single-json", "--flat-playlist", "--playlist-end", String(searchSize), "--no-warnings", query,
  ], { cwd: root, encoding: "utf8", maxBuffer: 30 * 1024 * 1024, timeout: 45_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `yt-dlp exited ${result.status}`);
  const payload = JSON.parse(result.stdout);
  writeFileSync(cacheFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function existingVerdict(candidate, source, canonicalEvidence) {
  const fingerprint = fingerprintById.get(candidate.id);
  const hostedDurationSeconds = Number(candidate.media?.hostedDurationMs) / 1000;
  const canonicalDurationSeconds = Number(canonicalEvidence?.durationSeconds);
  // A matching excerpt proves that the canonical recording appears somewhere
  // in the file; it does not prove the file is the complete album track. Music
  // videos can contain the master plus long skits/outros, while bad mirrors can
  // end early. Reject those length mismatches before accepting a fingerprint.
  if (Number.isFinite(hostedDurationSeconds)
    && Number.isFinite(canonicalDurationSeconds)
    && Math.abs(hostedDurationSeconds - canonicalDurationSeconds) > 5) {
    return { accepted: false, reason: "canonical-duration-mismatch", score: -1 };
  }
  let hostedVersion = null;
  try {
    hostedVersion = new URL(candidate.media?.hostedFullUrl).searchParams.get("v");
  } catch {
    // A malformed/missing hosted URL is handled by the normal source checks.
  }
  if (fingerprint?.status === "canonical_match"
    && fingerprint.contentVersion
    && fingerprint.contentVersion === hostedVersion) {
    return { accepted: true, reason: "canonical-acoustic-fingerprint", score: 1000 };
  }
  const sourceChannel = source?.youtube?.channel ?? "";
  const verifiedArtistChannel = Boolean(source?.youtube?.channelVerified)
    && candidate.primaryArtists.some((artist) => (
      containsPhrase(normalize(sourceChannel), normalize(artist))
      || compact(sourceChannel).includes(compact(artist))
    ));
  if (fingerprint?.status === "probable_match"
    && fingerprint.contentVersion
    && fingerprint.contentVersion === hostedVersion
    && verifiedArtistChannel
    && Number.isFinite(source?.youtube?.durationSeconds)
    && Number.isFinite(canonicalEvidence?.durationSeconds)
    && Math.abs(source.youtube.durationSeconds - canonicalEvidence.durationSeconds) <= 2.5) {
    return { accepted: true, reason: "probable-fingerprint-verified-artist", score: 900 };
  }
  const sourceCreditText = normalize(`${source?.youtube?.title ?? ""} ${source?.youtube?.channel ?? ""}`);
  const sourceTitle = normalize(source?.youtube?.title ?? "");
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const manuallyReviewedExactEdition = Boolean(source?.youtube?.manualReviewReason)
    && fingerprint?.status === "probable_match"
    && fingerprint.contentVersion
    && fingerprint.contentVersion === hostedVersion
    && titleOptions.some((title) => containsPhrase(sourceTitle, title))
    && candidate.primaryArtists.map(normalize).every((artist) => containsPhrase(sourceCreditText, artist))
    && Number.isFinite(source?.youtube?.durationSeconds)
    && Number.isFinite(canonicalEvidence?.durationSeconds)
    && Math.abs(source.youtube.durationSeconds - canonicalEvidence.durationSeconds) <= 2.5;
  // Some label masters fingerprint just outside the automatic threshold after
  // transcoding. Accept those only when an explicit human review, complete
  // credits, exact canonical duration, and a content-bound probable fingerprint
  // all corroborate the same hosted file.
  if (manuallyReviewedExactEdition) {
    return { accepted: true, reason: "probable-fingerprint-manual-exact-edition", score: 850 };
  }
  if (!source?.url || !source.youtube?.title || !source.youtube?.channel) {
    return { accepted: false, reason: "missing-auditable-source", score: -1 };
  }
  return inspect(candidate, {
    ...source.youtube,
    duration: source.youtube.durationSeconds,
    channel_is_verified: source.youtube.channelVerified,
  }, canonicalEvidence);
}

const report = {
  generatedAt: new Date().toISOString(),
  retained: [],
  replacements: [],
  unresolved: [],
  canonicalDurations: [],
  searched: 0,
};
let searched = 0;
for (const candidate of playable) {
  if (selectedIds.size > 0 && !selectedIds.has(candidate.id)) continue;
  if (verbose) console.log(`CHECK ${candidate.id}`);
  const source = sourceById.get(candidate.id);
  let canonical = null;
  const spotifyDurationSeconds = Number(candidate.spotifyDurationMs) / 1000;
  // A verified Spotify duration is enough for source gating, but an explicit
  // metadata refresh may still be needed to obtain an independent preview for
  // acoustic fingerprinting.
  if (!Number.isFinite(spotifyDurationSeconds) || refreshMetadata) {
    try {
      canonical = await canonicalMetadata(candidate);
    } catch (error) {
      if (verbose) console.warn(`  METADATA ${candidate.id}: ${error.message}`);
    }
  }
  const referenceDurationSeconds = Number.isFinite(spotifyDurationSeconds)
    ? spotifyDurationSeconds
    : canonical?.durationSeconds ?? null;
  const referenceDurationSource = Number.isFinite(spotifyDurationSeconds)
    ? "spotify_public_page"
    : canonical ? "itunes_search" : null;
  const canonicalEvidence = Number.isFinite(spotifyDurationSeconds)
    ? {
        durationSeconds: spotifyDurationSeconds,
        album: candidate.album ?? null,
        releaseYear: candidate.releaseYear ?? null,
        source: "spotify_public_page",
      }
    : canonical ? {
        durationSeconds: canonical.durationSeconds,
        album: canonical.collectionName ?? null,
        releaseYear: canonical.releaseYear ?? null,
        source: "itunes_search",
      } : null;
  const hostedDurationSeconds = Number(candidate.media?.hostedDurationMs) / 1000;
  report.canonicalDurations.push({
    id: candidate.id,
    hostedDurationSeconds: Number.isFinite(hostedDurationSeconds) ? hostedDurationSeconds : null,
    canonicalDurationSeconds: referenceDurationSeconds,
    referenceDurationSource,
    deltaSeconds: Number.isFinite(referenceDurationSeconds) && Number.isFinite(hostedDurationSeconds)
      ? Number((hostedDurationSeconds - referenceDurationSeconds).toFixed(3))
      : null,
    canonicalTrack: referenceDurationSource === "spotify_public_page"
      ? `${candidate.title} — ${candidate.artist}`
      : canonical ? `${canonical.trackName} — ${canonical.artistName}` : null,
    canonicalAlbum: referenceDurationSource === "spotify_public_page"
      ? candidate.album ?? null
      : canonical?.collectionName ?? null,
  });
  if (metadataOnly) continue;
  const currentVerdict = existingVerdict(candidate, source, canonicalEvidence);
  if (currentVerdict.accepted && !forceSearch) {
    report.retained.push({
      id: candidate.id,
      url: source?.url ?? null,
      title: source?.youtube?.title ?? null,
      channel: source?.youtube?.channel ?? null,
      durationSeconds: source?.youtube?.durationSeconds ?? null,
      evidence: currentVerdict.reason,
      score: Math.round(currentVerdict.score),
    });
    continue;
  }
  if (auditOnly) {
    report.unresolved.push({
      id: candidate.id,
      reason: currentVerdict.reason,
      score: Number.isFinite(currentVerdict.score) ? Math.round(currentVerdict.score) : null,
      title: source?.youtube?.title ?? null,
      channel: source?.youtube?.channel ?? null,
      durationSeconds: source?.youtube?.durationSeconds ?? null,
    });
    continue;
  }
  if (searched >= limit) break;
  searched += 1;
  report.searched += 1;
  try {
    const payload = cachedSearch(candidate, canonicalEvidence);
    const ranked = (payload.entries ?? []).map((entry) => ({ entry, ...inspect(candidate, entry, canonicalEvidence) }))
      .filter((entry) => entry.accepted)
      .sort((left, right) => right.score - left.score);
    if (verbose) {
      for (const result of (payload.entries ?? []).map((entry) => ({ entry, ...inspect(candidate, entry, canonicalEvidence) }))) {
        console.log(`  ${result.accepted ? "ACCEPT" : "REJECT"} ${result.reason}: ${result.entry.title} — ${result.entry.channel ?? result.entry.uploader ?? "unknown"}`);
      }
    }
    const selected = ranked[0];
    if (!selected) {
      report.unresolved.push({ id: candidate.id, reason: "no-strict-studio-result", previousReason: currentVerdict.reason });
      console.log(`REVIEW ${candidate.id}: no strict Topic/official-audio result`);
      continue;
    }
    const entry = selected.entry;
    const url = entry.url?.startsWith("http") ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`;
    report.replacements.push({
      id: candidate.id, previousUrl: source?.url ?? null, url, title: entry.title,
      channel: entry.channel ?? entry.uploader, durationSeconds: entry.duration, score: Math.round(selected.score),
    });
    if (apply) {
      const target = source ?? { id: candidate.id, title: candidate.title, artist: candidate.artist, url: "" };
      if (!source) {
        sourceRoot.songs.push(target);
        sourceById.set(candidate.id, target);
      }
      target.url = url;
      target.youtube = {
        videoId: entry.id,
        title: entry.title,
        channel: entry.channel ?? entry.uploader,
        channelId: entry.channel_id ?? entry.uploader_id ?? null,
        durationSeconds: entry.duration,
        channelVerified: Boolean(entry.channel_is_verified),
        description: entry.description ?? null,
        viewCount: Number.isFinite(entry.view_count) ? entry.view_count : null,
        score: Math.round(selected.score),
        resolutionMethod: "strict-studio-source-audit",
        resolvedAt: new Date().toISOString(),
      };
    }
    console.log(`${apply ? "SELECT" : "WOULD SELECT"} ${candidate.id}: ${entry.title} — ${entry.channel ?? entry.uploader}`);
  } catch (error) {
    report.unresolved.push({ id: candidate.id, reason: error.message, previousReason: currentVerdict.reason });
    console.error(`FAIL ${candidate.id}: ${error.message}`);
  }
}

if (apply) writeFileSync(sourceFile, `${JSON.stringify(sourceRoot, null, 2)}\n`, "utf8");
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\nRetained strict sources: ${report.retained.length}`);
console.log(`${apply ? "Applied" : "Proposed"} replacements: ${report.replacements.length}`);
console.log(`Unresolved: ${report.unresolved.length}`);
console.log(`Search requests used: ${report.searched}`);
console.log(`Metadata requests used: ${metadataRequests}`);
if (metadataOnly) {
  const resolvedDurations = report.canonicalDurations.filter((entry) => entry.canonicalDurationSeconds !== null);
  const mismatches = resolvedDurations.filter((entry) => Math.abs(entry.deltaSeconds) > 2.5);
  console.log(`Canonical durations: ${resolvedDurations.length}/${report.canonicalDurations.length}; mismatches over 2.5s: ${mismatches.length}`);
}
console.log(`Report: ${path.relative(root, reportFile)}`);
