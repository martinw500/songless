import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = JSON.parse(readFileSync(path.join(root, "data", "song-candidates.json"), "utf8")).songs;
const sources = JSON.parse(readFileSync(path.join(root, "data", "song-download-sources.local.json"), "utf8")).songs;
const allowPending = process.argv.includes("--allow-pending");

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsPhrase(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

const alteredVersion = /\b(live|concert|performance|sessions?|acoustic|stripped|orchestral|lullaby|animatic|footnotes|a ?cappella|acapella|remix|dub|medley|sped up|slowed|reverb|nightcore|cover|karaoke|instrumental|censored|clean version|radio edit|extended|edit|editions?|re[- ]?recorded|rerecorded|remake|w(?:\/|\s)?o|without|loop|reaction|bass boosted|8d|mashup|parody|tutorial|snippet|teaser|demo|unreleased|fan ?made|shorts?|compilation|playlist|interview|meaning|explained|breakdown|making of|footnotes|behind the scenes?|documentary|visuals?|visuali[sz]er|verified|ai (?:cover|version)|vocals? only|music only)\b/iu;
function hasUnexpectedFeature(versionText) {
  const featureText = versionText.match(/\b(?:feat|ft|featuring|with)\b([\s\S]*)/iu)?.[1];
  if (!featureText) return false;
  const remainder = featureText.replace(/\b(?:and|official|audio|video|music|lyrics?|visualizer|hd|4k)\b/giu, " ").trim();
  return /\p{L}/u.test(remainder);
}
const errors = [];
const warnings = [];
const sourceById = new Map(sources.map((source) => [source.id, source]));
const candidateIds = new Set(candidates.map((candidate) => candidate.id));
const videoOwners = new Map();
let resolved = 0;

for (const source of sources) {
  if (!candidateIds.has(source.id)) errors.push(`${source.id}: source row has no candidate.`);
}

for (const candidate of candidates) {
  const source = sourceById.get(candidate.id);
  if (!source) {
    errors.push(`${candidate.id}: missing source row.`);
    continue;
  }
  if (!source.url) {
    if (!allowPending) errors.push(`${candidate.id}: source is unresolved.`);
    continue;
  }
  resolved += 1;
  const metadata = source.youtube;
  if (!metadata?.videoId || !metadata?.title || !metadata?.channel) {
    errors.push(`${candidate.id}: resolved source lacks auditable YouTube metadata.`);
    continue;
  }
  const duplicateOwner = videoOwners.get(metadata.videoId);
  if (duplicateOwner) errors.push(`${candidate.id}: duplicates video ${metadata.videoId} already used by ${duplicateOwner}.`);
  else videoOwners.set(metadata.videoId, candidate.id);

  const resultTitle = normalize(metadata.title);
  const titleOptions = [candidate.title, ...(candidate.aliases ?? [])].map(normalize);
  const songTitle = titleOptions.find((title) => containsPhrase(resultTitle, title));
  const artists = candidate.primaryArtists.map(normalize);
  const channel = normalize(metadata.channel);
  if (!songTitle) {
    errors.push(`${candidate.id}: selected title does not contain the song title or an accepted alias.`);
    continue;
  }
  const matchedArtists = artists.filter((artist) => containsPhrase(`${resultTitle} ${channel}`, artist));
  const aliasMatch = (candidate.artistAliases ?? []).map(normalize).some((artist) => containsPhrase(`${resultTitle} ${channel}`, artist));
  if (matchedArtists.length === 0 && !aliasMatch) {
    errors.push(`${candidate.id}: selected title/channel does not contain a primary artist.`);
  }
  const missingArtists = candidate.primaryArtists.filter((_, index) => !matchedArtists.includes(artists[index]));
  if (missingArtists.length) warnings.push(`${candidate.id}: exact-version check is missing credit text for ${missingArtists.join(", ")}.`);
  let versionText = ` ${resultTitle} `.replace(` ${songTitle} `, " ");
  for (const artist of artists) {
    while (versionText.includes(` ${artist} `)) versionText = versionText.replace(` ${artist} `, " ");
  }
  if (alteredVersion.test(versionText)) errors.push(`${candidate.id}: selected title signals an altered or non-song version.`);
  if (hasUnexpectedFeature(versionText)) errors.push(`${candidate.id}: selected title contains an unexpected featured artist.`);
  if (/\s\/\s/u.test(metadata.title) && !candidate.title.includes("/")) errors.push(`${candidate.id}: selected source combines multiple songs.`);
  if (/\bremaster(?:ed)?\b/iu.test(versionText)) warnings.push(`${candidate.id}: official remaster selected; confirm this version is acceptable.`);
  if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds < 75 || metadata.durationSeconds > 720) {
    errors.push(`${candidate.id}: duration must be between 75 and 720 seconds.`);
  }
  const compactChannel = channel.replace(/\s+/gu, "");
  const artistAliases = (candidate.artistAliases ?? []).map(normalize);
  const artistChannelMatch = [...artists, ...artistAliases].some((artist) => containsPhrase(channel, artist)
    || (artist.replace(/\s+/gu, "").length >= 4 && compactChannel.includes(artist.replace(/\s+/gu, ""))));
  const officialSignal = channel.includes("topic") || channel.includes("vevo") || containsPhrase(channel, "official")
    || artistChannelMatch || (Boolean(metadata.channelVerified) && /\bofficial audio\b/iu.test(metadata.title));
  if (!officialSignal && metadata.manualReviewReason) warnings.push(`${candidate.id}: manually vetted source (${metadata.manualReviewReason}).`);
  else if (!officialSignal) errors.push(`${candidate.id}: channel lacks artist, Topic, VEVO, official, or verified provenance.`);
  if (songTitle.split(" ").length <= 2 && !/\bofficial audio\b/iu.test(metadata.title) && !channel.includes("topic")) {
    warnings.push(`${candidate.id}: generic short title needs an extra identity check.`);
  }
}

console.log(`YouTube sources: ${resolved}/${candidates.length} resolved; ${warnings.length} confidence warning(s).`);
for (const warning of warnings) console.log(`WARN ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log("YouTube source audit passed.");
}
