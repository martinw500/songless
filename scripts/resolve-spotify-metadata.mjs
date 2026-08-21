import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
const dryRun = process.argv.includes("--dry-run");
const verbose = process.argv.includes("--verbose");
if (!clientId || !clientSecret || /^your_/iu.test(clientId) || /^your_/iu.test(clientSecret)) {
  throw new Error("Optional Spotify metadata lookup needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in ignored .env.local.");
}

// --- Normalization ---
function normalized(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\b(feat|featuring|ft|with)\.?\b.*$/u, "")
    .replace(/\b(remaster(?:ed)?|radio edit|single version)\b.*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// --- Version rejection filters ---
const REJECTED_PATTERNS = [
  // Live versions
  /\b(live|en vivo|ao vivo|concert|mtv unplugged)\b/iu,
  // Remixes
  /\b(remix|rmx|rework|bootleg|dub mix|club mix|extended mix)\b/iu,
  // Acoustic versions
  /\b(acoustic|stripped|unplugged)\b/iu,
  // Clean/radio edits
  /\b(clean|radio edit|censored|edited version)\b/iu,
  // Speed alterations
  /\b(sped[- ]?up|slowed|nightcore|daycore|chopped|screwed)\b/iu,
  // Rerecordings
  /\b(re-?record(?:ed|ing)?|taylor'?s version|tv)\b/iu,
  // Karaoke/covers
  /\b(karaoke|instrumental|cover|tribute|in the style of|originally performed)\b/iu,
  // Demos/alternates
  /\b(demo|alternate|alternative version|rough mix|early take)\b/iu,
];

function isRejectedVersion(trackName, albumName) {
  // Strip the candidate title portion to check only suffixes/parenthetical tags
  const combined = (trackName + " " + (albumName || "")).toLowerCase();
  for (const pattern of REJECTED_PATTERNS) {
    if (pattern.test(combined)) return pattern.source;
  }
  return null;
}

// --- Featured artist matching ---
function normalizedArtistSet(artists) {
  return new Set(artists.map(a => normalized(a)));
}

function verifyArtistCredits(spotifyTrack, candidateArtists) {
  const spotifyArtists = (spotifyTrack.artists || []).map(a => normalized(a.name));
  const expected = normalizedArtistSet(candidateArtists);
  const matched = spotifyArtists.filter(a => expected.has(a));
  const unexpected = spotifyArtists.filter(a => !expected.has(a));
  const missing = [...expected].filter(a => !spotifyArtists.includes(a));
  return { matched, unexpected, missing, allMatch: missing.length === 0 && unexpected.length === 0 };
}

// --- Spotify API ---
async function accessToken() {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const value = await response.json();
  if (!response.ok || !value.access_token) throw new Error(`Spotify metadata token request failed (${response.status}).`);
  return value.access_token;
}

// --- Main ---
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const token = await accessToken();
let resolved = 0;
const unresolved = [];
const rejected = [];
const flagged = [];
const artistMismatches = [];

for (const song of candidateRoot.songs) {
  if (song.spotifyUrl && song.album && song.media?.artworkUrl && song.media?.spotifyPreviewUrl) continue;
  const primaryArtist = song.primaryArtists[0];
  const query = encodeURIComponent(`track:${song.title} artist:${primaryArtist}`);
  const response = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const value = await response.json();
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") || "unknown";
    console.warn(`Spotify rate limit hit! Retry-After: ${retryAfter} seconds. Saving progress and exiting cleanly.`);
    break;
  }
  if (!response.ok) throw new Error(`Spotify metadata search failed for ${song.title} (${response.status}).`);

  const title = normalized(song.title);
  const artists = song.primaryArtists.map(normalized);

  // Filter candidates: exact title + at least one primary artist match
  const candidates = (value.tracks?.items ?? []).filter((track) => (
    normalized(track.name) === title
    && track.artists?.some((artist) => artists.includes(normalized(artist.name)))
  ));

  if (candidates.length === 0) {
    unresolved.push(`${song.title} — ${song.artist}`);
    continue;
  }

  // Reject altered versions
  let bestMatch = null;
  for (const track of candidates) {
    const rejectionReason = isRejectedVersion(track.name, track.album?.name);
    if (rejectionReason) {
      rejected.push(`${song.title} — ${song.artist}: rejected "${track.name}" from "${track.album?.name}" (${rejectionReason})`);
      continue;
    }
    // Prefer the first non-rejected match
    if (!bestMatch) bestMatch = track;
  }

  if (!bestMatch) {
    flagged.push(`${song.title} — ${song.artist}: all ${candidates.length} matches were altered versions`);
    continue;
  }

  // Verify artist credits
  const creditCheck = verifyArtistCredits(bestMatch, song.primaryArtists);
  if (!creditCheck.allMatch) {
    const details = [];
    if (creditCheck.missing.length) details.push(`missing: ${creditCheck.missing.join(", ")}`);
    if (creditCheck.unexpected.length) details.push(`unexpected: ${creditCheck.unexpected.join(", ")}`);
    artistMismatches.push(`${song.title} — ${song.artist}: ${details.join("; ")}`);
    // Still apply metadata but flag it
  }

  // Apply metadata — never overwrite curated titles or aliases
  song.album = song.album || bestMatch.album?.name;
  song.spotifyUrl = song.spotifyUrl || bestMatch.external_urls?.spotify;

  // Use R2-hosted artwork if already present; otherwise use Spotify CDN
  if (!song.media.artworkUrl || /^https:\/\/i\.scdn\.co\//.test(song.media.artworkUrl)) {
    // Only update if not already an R2 URL
    if (!/r2\.dev\//.test(song.media.artworkUrl || "")) {
      const artworkUrl = bestMatch.album?.images?.find((image) => image.width >= 300)?.url
        ?? bestMatch.album?.images?.[0]?.url;
      if (artworkUrl) song.media.artworkUrl = artworkUrl;
    }
  }

  // Save Spotify preview URL for hook detection (no extra API call)
  if (bestMatch.preview_url && !song.media.spotifyPreviewUrl) {
    song.media.spotifyPreviewUrl = bestMatch.preview_url;
  }

  resolved += 1;
  if (verbose) {
    const previewStatus = bestMatch.preview_url ? "✓" : "✗";
    console.log(`✓ ${song.title} — album: "${bestMatch.album?.name}", preview: ${previewStatus}, spotify: ${bestMatch.external_urls?.spotify}`);
  }
}

// Report
console.log(`\n=== Spotify Metadata Resolution ===`);
console.log(`${dryRun ? "Would attach" : "Attached"} optional Spotify metadata to ${resolved} song(s).`);
console.log(`Unresolved: ${unresolved.length}`);
console.log(`Rejected (altered versions): ${rejected.length}`);
console.log(`Flagged (all matches altered): ${flagged.length}`);
console.log(`Artist credit mismatches: ${artistMismatches.length}`);

if (unresolved.length > 0) {
  console.log(`\nUnresolved (need manual matching):`);
  for (const label of unresolved) console.log(`  REVIEW ${label}`);
}
if (rejected.length > 0 && verbose) {
  console.log(`\nRejected versions:`);
  for (const label of rejected) console.log(`  SKIP ${label}`);
}
if (flagged.length > 0) {
  console.log(`\nFlagged (all matches were altered):`);
  for (const label of flagged) console.log(`  FLAG ${label}`);
}
if (artistMismatches.length > 0) {
  console.log(`\nArtist credit discrepancies:`);
  for (const label of artistMismatches) console.log(`  MISMATCH ${label}`);
}

if (!dryRun) {
  writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
  console.log(`\nWrote updated metadata to song-candidates.json.`);
} else {
  console.log(`\n[DRY RUN] No changes written.`);
}
