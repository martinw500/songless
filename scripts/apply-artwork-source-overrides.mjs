import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertWithinR2Budget } from "./r2-storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const overridesFile = path.join(root, "data", "artwork-source-overrides.json");
const artworkDirectory = path.join(root, "private-media", "r2", "artwork");
const apply = process.argv.includes("--apply");
const selectedIds = new Set(
  (process.argv.find((value) => value.startsWith("--id="))?.split("=")[1] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean),
);

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const configured = JSON.parse(readFileSync(overridesFile, "utf8")).overrides ?? [];
const overrides = configured.filter((override) => selectedIds.size === 0 || selectedIds.has(override.id));
const songsById = new Map(candidateRoot.songs.map((song) => [song.id, song]));

if (overrides.length === 0) throw new Error("No artwork source overrides selected.");
for (const override of overrides) {
  if (!songsById.has(override.id)) throw new Error(`${override.id}: candidate does not exist`);
  if (!override.reason?.trim()) throw new Error(`${override.id}: a review reason is required`);
  if (!/^https:\/\/i\.scdn\.co\/image\//u.test(override.artworkSourceUrl ?? "")) {
    throw new Error(`${override.id}: artworkSourceUrl must be a verified Spotify image URL`);
  }
  if (!/^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]{22}$/u.test(override.spotifyVerificationUrl ?? "")) {
    throw new Error(`${override.id}: spotifyVerificationUrl must identify the reviewed public track page`);
  }
}

function md5(bytes) {
  return createHash("md5").update(bytes).digest("hex");
}

function decodeHtml(value = "") {
  return value
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gu, "&").replace(/&quot;/gu, '"').replace(/&#39;|&apos;/gu, "'");
}

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function metaContent(html, property) {
  for (const tag of html.match(/<meta\s+[^>]*>/giu) ?? []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([:\w-]+)=(?:"([^"]*)"|'([^']*)')/gu)]
      .map((match) => [match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? "")]));
    if ((attributes.property ?? attributes.name) === property) return attributes.content ?? null;
  }
  return null;
}

async function verifySpotifyPage(override, song) {
  const response = await fetch(override.spotifyVerificationUrl, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SonglessArtworkReview/1.0)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${override.id}: Spotify public page returned ${response.status}`);
  const html = await response.text();
  const title = metaContent(html, "og:title") ?? "";
  const description = metaContent(html, "og:description") ?? "";
  const artworkUrl = metaContent(html, "og:image") ?? "";
  const acceptedTitles = [song.title, ...(song.aliases ?? [])].map(normalize);
  if (!acceptedTitles.includes(normalize(title))) {
    throw new Error(`${override.id}: Spotify page title is ${JSON.stringify(title)}, expected ${JSON.stringify(song.title)}`);
  }
  if (!normalize(description).includes(normalize(override.album))) {
    throw new Error(`${override.id}: Spotify page does not identify reviewed album ${JSON.stringify(override.album)}`);
  }
  if (!song.primaryArtists.every((artist) => normalize(description).includes(normalize(artist)))) {
    throw new Error(`${override.id}: Spotify page does not contain every expected primary artist`);
  }
  if (artworkUrl !== override.artworkSourceUrl) {
    throw new Error(`${override.id}: Spotify page artwork changed; review the replacement before applying`);
  }
}

function sniffContentType(bytes, responseType = "") {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (/^image\//iu.test(responseType)) return responseType.split(";")[0];
  throw new Error("downloaded bytes are not a recognized image");
}

async function downloadImage(override) {
  const response = await fetch(override.artworkSourceUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${override.id}: artwork download returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 3_000) throw new Error(`${override.id}: artwork is unexpectedly small (${bytes.length} bytes)`);
  return {
    ...override,
    bytes,
    contentType: sniffContentType(bytes, response.headers.get("content-type") ?? ""),
    hash: md5(bytes),
    key: `artwork/${override.id}.jpg`,
  };
}

const prepared = [];
for (const override of overrides) {
  await verifySpotifyPage(override, songsById.get(override.id));
  const image = await downloadImage(override);
  prepared.push(image);
  console.log(`${override.id}: ${override.album}; ${image.bytes.length} bytes; md5 ${image.hash}`);
}

if (!apply) {
  console.log(`[DRY RUN] Verified ${prepared.length} replacement source(s). No R2 objects or repository files changed.`);
  process.exit(0);
}

const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL"];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required in ignored .env.local for --apply.`);
}
const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const bucket = process.env.R2_BUCKET;
const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/u, "");
const maxBytes = Number(process.env.R2_MAX_BYTES ?? 8_500_000_000);
const objects = new Map();
let continuationToken;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
  for (const object of page.Contents ?? []) if (object.Key) objects.set(object.Key, object.Size ?? 0);
  continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (continuationToken);
const currentBytes = [...objects.values()].reduce((total, size) => total + size, 0);
const replacedBytes = prepared.reduce((total, image) => total + (objects.get(image.key) ?? 0), 0);
const replacementBytes = prepared.reduce((total, image) => total + image.bytes.length, 0);
const projectedBytes = currentBytes - replacedBytes + replacementBytes;
assertWithinR2Budget(projectedBytes, maxBytes);
console.log(`Projected R2 usage: ${(projectedBytes / 1_000_000_000).toFixed(3)} GB.`);

mkdirSync(artworkDirectory, { recursive: true });
for (const image of prepared) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: image.key,
    Body: image.bytes,
    ContentLength: image.bytes.length,
    ContentType: image.contentType,
    CacheControl: "public, max-age=86400",
    Metadata: {
      "songless-artwork-source": "spotify-reviewed-override",
      "songless-source-track": image.spotifyVerificationUrl.split("/").at(-1),
    },
  }));
  writeFileSync(path.join(artworkDirectory, `${image.id}.jpg`), image.bytes);
  const song = songsById.get(image.id);
  song.album = image.album;
  song.releaseYear = image.releaseYear;
  if (image.spotifyUrl) song.spotifyUrl = image.spotifyUrl;
  song.media.artworkUrl = `${publicBaseUrl}/${image.key}?v=spotify-${image.hash.slice(0, 12)}`;
  image.artworkMd5 = image.hash;
}

for (const override of configured) {
  const image = prepared.find((entry) => entry.id === override.id);
  if (image) override.artworkMd5 = image.hash;
}
writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
writeFileSync(overridesFile, `${JSON.stringify({ schemaVersion: 1, overrides: configured }, null, 2)}\n`, "utf8");
console.log(`Applied ${prepared.length} reviewed artwork source override(s). Regenerate the public catalogue next.`);
