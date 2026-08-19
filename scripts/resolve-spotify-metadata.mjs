import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
const dryRun = process.argv.includes("--dry-run");
if (!clientId || !clientSecret || /^your_/iu.test(clientId) || /^your_/iu.test(clientSecret)) {
  throw new Error("Optional Spotify metadata lookup needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in ignored .env.local.");
}

function normalized(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\b(feat|featuring|ft|with)\.?\b.*$/u, "")
    .replace(/\b(remaster(?:ed)?|radio edit|single version)\b.*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

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

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const token = await accessToken();
let resolved = 0;
const unresolved = [];

for (const song of candidateRoot.songs) {
  if (song.spotifyUrl && song.album && song.media?.artworkUrl) continue;
  const primaryArtist = song.primaryArtists[0];
  const query = encodeURIComponent(`track:${song.title} artist:${primaryArtist}`);
  const response = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Spotify metadata search failed for ${song.title} (${response.status}).`);
  const title = normalized(song.title);
  const artists = song.primaryArtists.map(normalized);
  const exact = (value.tracks?.items ?? []).find((track) => (
    normalized(track.name) === title
    && track.artists?.some((artist) => artists.includes(normalized(artist.name)))
  ));
  if (!exact) {
    unresolved.push(`${song.title} — ${song.artist}`);
    continue;
  }
  song.album = exact.album?.name ?? song.album;
  song.spotifyUrl = exact.external_urls?.spotify ?? song.spotifyUrl;
  song.media.artworkUrl = exact.album?.images?.find((image) => image.width >= 300)?.url
    ?? exact.album?.images?.[0]?.url
    ?? song.media.artworkUrl;
  resolved += 1;
}

if (!dryRun) writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`${dryRun ? "Would attach" : "Attached"} optional Spotify metadata to ${resolved} song(s); ${unresolved.length} need manual matching.`);
for (const label of unresolved) console.log(`REVIEW ${label}`);
