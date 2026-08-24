import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertWithinR2Budget, projectedBucketBytes } from "./r2-storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preparedRoot = path.join(root, "private-media", "r2");
const localManifestFile = path.join(preparedRoot, "manifest.json");
const candidateFile = path.join(root, "data", "song-candidates.json");
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--dry-run=true");
const catalogOnly = process.argv.includes("--catalog-only");
const connectionCheck = process.argv.includes("--check");
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

if (connectionCheck) {
  const existing = await listObjects();
  const existingBytes = [...existing.values()].reduce((total, size) => total + size, 0);
  console.log(`R2 connection passed for bucket ${bucket}.`);
  console.log(`Current objects: ${existing.size}; storage: ${(existingBytes / 1_000_000_000).toFixed(3)} GB; safety ceiling: ${(maxBytes / 1_000_000_000).toFixed(3)} GB.`);
  process.exit(0);
}

const localManifest = JSON.parse(readFileSync(localManifestFile, "utf8"));
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const candidateById = new Map(candidateRoot.songs.map((song) => [song.id, song]));
const songs = localManifest.songs.filter((song) => selectedIds.size === 0 || selectedIds.has(song.id));
if (selectedIds.size > 0 && songs.length !== selectedIds.size) {
  const found = new Set(songs.map((song) => song.id));
  throw new Error(`Prepared manifest does not contain: ${[...selectedIds].filter((id) => !found.has(id)).join(", ")}.`);
}
if (songs.length === 0) throw new Error("No prepared songs are available to upload.");

function publicUrl(key, version) {
  const url = `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

function localAsset(relativeFile, key, contentType) {
  const absoluteFile = path.resolve(preparedRoot, relativeFile);
  if (!absoluteFile.startsWith(`${preparedRoot}${path.sep}`)) throw new Error(`Prepared path escapes its root: ${relativeFile}`);
  const size = statSync(absoluteFile).size;
  const contentVersion = createHash("sha256").update(readFileSync(absoluteFile)).digest("hex").slice(0, 12);
  return { absoluteFile, key, size, contentType, contentVersion };
}

const assets = [];
for (const song of songs) {
  if (!candidateById.has(song.id)) throw new Error(`Unknown candidate in prepared manifest: ${song.id}.`);
  assets.push(localAsset(song.fullFile, `audio/full/${song.id}.mp3`, "audio/mpeg"));
  assets.push(localAsset(song.clueFile, `audio/clues/${song.id}.mp3`, "audio/mpeg"));
}
const assetByKey = new Map(assets.map((asset) => [asset.key, asset]));

const existing = await listObjects();
const { existingBytes, projectedBytes } = projectedBucketBytes(existing, assets);
console.log(`R2 bucket currently: ${(existingBytes / 1_000_000_000).toFixed(3)} GB`);
console.log(`After this batch:    ${(projectedBytes / 1_000_000_000).toFixed(3)} GB`);
console.log(`Hard safety ceiling: ${(maxBytes / 1_000_000_000).toFixed(3)} GB`);
assertWithinR2Budget(projectedBytes, maxBytes);

if (!dryRun) {
  if (!catalogOnly) {
    const concurrency = 20;
    for (let i = 0; i < assets.length; i += concurrency) {
      const chunk = assets.slice(i, i + concurrency);
      await Promise.all(chunk.map(async (asset) => {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: asset.key,
          Body: createReadStream(asset.absoluteFile),
          ContentLength: asset.size,
          ContentType: asset.contentType,
          CacheControl: "public, max-age=3600",
        }));
        console.log(`UPLOADED ${asset.key} (${(asset.size / 1_000_000).toFixed(2)} MB)`);
      }));
    }
  }

  const verified = await listObjects();
  const verifiedBytes = [...verified.values()].reduce((total, size) => total + size, 0);
  if (verifiedBytes > maxBytes) throw new Error("R2 verification exceeded the configured ceiling. Stop uploading and inspect the bucket immediately.");
  const missingKeys = assets.filter((asset) => !verified.has(asset.key)).map((asset) => asset.key);
  if (missingKeys.length) throw new Error(`R2 is missing expected objects: ${missingKeys.join(", ")}`);

  for (const song of songs) {
    const candidate = candidateById.get(song.id);
    const clueKey = `audio/clues/${song.id}.mp3`;
    const fullKey = `audio/full/${song.id}.mp3`;
    candidate.media.hostedClueUrl = publicUrl(clueKey, assetByKey.get(clueKey).contentVersion);
    candidate.media.hostedFullUrl = publicUrl(fullKey, assetByKey.get(fullKey).contentVersion);
    candidate.media.hostedDurationMs = song.durationMs;
    candidate.reviewStatus = "needs_intro_review";
  }
  writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
}

const action = dryRun ? "Validated" : catalogOnly ? "Synchronized catalogue URLs for" : "Uploaded";
console.log(`${action} ${songs.length} song(s) and ${assets.length} object(s) without crossing the safety ceiling.`);
