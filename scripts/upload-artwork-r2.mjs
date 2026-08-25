import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertWithinR2Budget, projectedBucketBytes } from "./r2-storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const dryRun = process.argv.includes("--dry-run");
const idIndex = process.argv.indexOf("--id");
const inlineIds = process.argv.find((value) => value.startsWith("--id="))?.slice("--id=".length);
const selectedIds = new Set((inlineIds ?? (idIndex >= 0 ? process.argv[idIndex + 1] : ""))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL"];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required in ignored .env.local.`);
}

const maxBytes = Number(process.env.R2_MAX_BYTES ?? 8_500_000_000);
assertWithinR2Budget(0, maxBytes);
const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/u, "");
if (!/^https:\/\//u.test(publicBaseUrl)) throw new Error("R2_PUBLIC_BASE_URL must use HTTPS.");

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const bucket = process.env.R2_BUCKET;

function publicUrl(key) {
  return `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function listObjects() {
  const objects = new Map();
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const object of page.Contents ?? []) {
      if (object.Key) objects.set(object.Key, object.Size ?? 0);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const songs = selectedIds.size > 0
  ? candidateRoot.songs.filter((song) => selectedIds.has(song.id))
  : candidateRoot.songs;
if (selectedIds.size > 0 && songs.length !== selectedIds.size) {
  const found = new Set(songs.map((song) => song.id));
  throw new Error(`Unknown artwork candidate ids: ${[...selectedIds].filter((id) => !found.has(id)).join(", ")}.`);
}

// Identify songs with Spotify CDN artwork that need R2 rehosting
const toUpload = [];
const alreadyR2 = [];
const noArtwork = [];

for (const song of songs) {
  const url = song.media?.artworkUrl;
  if (!url) {
    noArtwork.push(song.id);
    continue;
  }
  // Already on R2
  if (url.includes("r2.dev/") || url.includes(publicBaseUrl.replace("https://", ""))) {
    alreadyR2.push(song.id);
    continue;
  }
  // Spotify CDN or other external URL
  toUpload.push(song);
}

console.log(`=== Artwork R2 Rehost ===`);
if (selectedIds.size > 0) console.log(`Filtered ids: ${selectedIds.size}`);
console.log(`Already on R2: ${alreadyR2.length}`);
console.log(`Need rehosting: ${toUpload.length}`);
console.log(`No artwork URL: ${noArtwork.length}`);
if (toUpload.length > 0 && (dryRun || selectedIds.size > 0)) {
  console.log(`Upload candidates: ${toUpload.map((song) => song.id).join(", ")}`);
}

if (toUpload.length === 0) {
  console.log("\nNothing to upload.");
  process.exit(0);
}

// Calculate projected R2 usage
// Album covers are typically 60-150KB at 300-640px; estimate 100KB per image
const estimatedBytesPerCover = 100_000;
const projectedNewBytes = toUpload.length * estimatedBytesPerCover;
console.log(`\nProjected new artwork: ~${(projectedNewBytes / 1_000_000).toFixed(2)} MB (${toUpload.length} × ~100KB)`);

const existing = await listObjects();
const existingBytes = [...existing.values()].reduce((total, size) => total + size, 0);
const projectedTotal = existingBytes + projectedNewBytes;
console.log(`Current R2 usage: ${(existingBytes / 1_000_000_000).toFixed(3)} GB`);
console.log(`Projected after artwork: ${(projectedTotal / 1_000_000_000).toFixed(3)} GB`);
console.log(`Safety ceiling: ${(maxBytes / 1_000_000_000).toFixed(3)} GB`);

assertWithinR2Budget(projectedTotal, maxBytes);

if (dryRun) {
  console.log("\n[DRY RUN] No uploads performed.");
  process.exit(0);
}

// Download and upload each cover
let uploaded = 0;
let failed = 0;

for (const song of toUpload) {
  const sourceUrl = song.media.artworkUrl;
  const r2Key = `artwork/${song.id}.jpg`;

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      console.warn(`SKIP ${song.id}: fetch failed (${response.status})`);
      failed += 1;
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "image/jpeg";

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: contentType,
      CacheControl: "public, max-age=86400",
    }));

    // Update candidate to use R2 URL
    const mediaVersion = `${song.media.hostedDurationMs}-0`;
    song.media.artworkUrl = `${publicUrl(r2Key)}?v=${encodeURIComponent(mediaVersion)}`;
    uploaded += 1;
    console.log(`UPLOADED ${r2Key} (${(buffer.length / 1000).toFixed(1)} KB)`);
  } catch (err) {
    console.warn(`SKIP ${song.id}: ${err.message}`);
    failed += 1;
  }
}

// Verify final bucket size
const verifiedObjects = await listObjects();
const verifiedBytes = [...verifiedObjects.values()].reduce((total, size) => total + size, 0);
if (verifiedBytes > maxBytes) {
  throw new Error("R2 verification exceeded the configured ceiling. Stop uploading and inspect the bucket immediately.");
}

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");

console.log(`\nUploaded: ${uploaded}`);
console.log(`Failed: ${failed}`);
console.log(`Final R2 usage: ${(verifiedBytes / 1_000_000_000).toFixed(3)} GB`);
console.log(`Updated artwork URLs in song-candidates.json.`);
