import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertWithinR2Budget } from "./r2-storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const catalogFile = path.join(root, "public", "catalog.json");
const artworkDirectory = path.join(root, "private-media", "r2", "artwork");
const spotifyPageDirectory = path.join(root, "data", "spotify-track-pages.local");
const itunesMetadataDirectory = path.join(root, "data", "itunes-track-metadata.local");
const reportFile = path.join(root, "data", "artwork-repair-report.local.json");
const apply = process.argv.includes("--apply");
const includeNonLive = process.argv.includes("--all");
const quarantineMissing = process.argv.includes("--quarantine-missing");
const poisonedEtag = (process.argv.find((value) => value.startsWith("--etag="))?.split("=")[1]
  ?? "353d5e66d18f33a612b802a839a957fe").toLowerCase();
const unrelatedCompilationPattern = /\b(?:sing[ -]?along|karaoke|made famous|in the style of|sound[ -]?alike|top motivation|workout|fitness|kids bop|\d+ greatest .*songs)\b/iu;

const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL"];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required in ignored .env.local.`);
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
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const liveIds = new Set(JSON.parse(readFileSync(catalogFile, "utf8")).map((song) => song.id));

function artworkKey(song) {
  return `artwork/${song.id}.jpg`;
}

function referencesArtworkKey(song) {
  try {
    return decodeURIComponent(new URL(song.media?.artworkUrl).pathname.replace(/^\/+/, "")) === artworkKey(song);
  } catch {
    return false;
  }
}

function md5(bytes) {
  return createHash("md5").update(bytes).digest("hex");
}

function spotifyArtwork(song) {
  const cacheFile = path.join(spotifyPageDirectory, `${song.id}.json`);
  if (!existsSync(cacheFile)) return null;
  const page = JSON.parse(readFileSync(cacheFile, "utf8"));
  if (page.url !== song.spotifyUrl || !/^https:\/\/i\.scdn\.co\/image\//u.test(page.artworkUrl ?? "")) return null;
  return page.artworkUrl;
}

function itunesMetadata(song) {
  const cacheFile = path.join(itunesMetadataDirectory, `${song.id}.json`);
  if (!existsSync(cacheFile)) return null;
  const metadata = JSON.parse(readFileSync(cacheFile, "utf8"));
  if (!metadata || !Number.isInteger(metadata.trackId)) return null;
  return metadata;
}

function itunesTrackId(song) {
  const metadata = itunesMetadata(song);
  if (!metadata || unrelatedCompilationPattern.test(metadata.collectionName ?? "")) return null;
  return metadata.trackId;
}

async function listObjects() {
  const objects = new Map();
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      objects.set(object.Key, {
        etag: object.ETag?.replaceAll('"', "").toLowerCase() ?? null,
        size: object.Size ?? 0,
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function lookupItunesArtwork(ids) {
  const artworkByTrackId = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const response = await fetch(`https://itunes.apple.com/lookup?id=${chunk.join(",")}&country=CA&entity=song`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`iTunes artwork lookup returned ${response.status}`);
    const payload = await response.json();
    for (const result of payload.results ?? []) {
      if (!Number.isInteger(result.trackId) || !result.artworkUrl100) continue;
      artworkByTrackId.set(result.trackId, result.artworkUrl100
        .replace(/100x100(?:bb|cc)\.jpg/iu, "600x600cc.jpg"));
    }
  }
  return artworkByTrackId;
}

function sniffContentType(bytes, responseType = "") {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (/^image\//iu.test(responseType)) return responseType.split(";")[0];
  throw new Error("downloaded bytes are not a recognized image");
}

async function downloadImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`artwork download returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 3_000) throw new Error(`artwork is unexpectedly small (${bytes.length} bytes)`);
  return { bytes, contentType: sniffContentType(bytes, response.headers.get("content-type") ?? "") };
}

const initialObjects = await listObjects();
const targets = candidateRoot.songs.filter((song) => (
  initialObjects.get(artworkKey(song))?.etag === poisonedEtag
  && referencesArtworkKey(song)
  && (includeNonLive || liveIds.has(song.id))
));
if (targets.length === 0) {
  console.log(`No artwork objects use poisoned checksum ${poisonedEtag}.`);
  process.exit(0);
}

const missingSpotifyTargets = targets.filter((song) => !spotifyArtwork(song));
const itunesIds = [...new Set(missingSpotifyTargets.map(itunesTrackId).filter(Number.isInteger))];
const itunesArtwork = await lookupItunesArtwork(itunesIds);
const plans = targets.map((song) => {
  const spotifyUrl = spotifyArtwork(song);
  const trackId = itunesTrackId(song);
  const itunesUrl = trackId ? itunesArtwork.get(trackId) ?? null : null;
  const localFile = path.join(artworkDirectory, `${song.id}.jpg`);
  const rejectedCompilation = unrelatedCompilationPattern.test(itunesMetadata(song)?.collectionName ?? "");
  return {
    song,
    key: artworkKey(song),
    source: spotifyUrl ? "spotify-canonical" : itunesUrl ? "itunes-canonical" : existsSync(localFile) && !rejectedCompilation ? "local-song-fallback" : "missing",
    sourceUrl: spotifyUrl ?? itunesUrl,
    localFile,
  };
});

const counts = Object.fromEntries([...new Set(plans.map((plan) => plan.source))]
  .map((source) => [source, plans.filter((plan) => plan.source === source).length]));
console.log(`Poisoned ${includeNonLive ? "candidate" : "live catalogue"} objects: ${plans.length}.`);
for (const [source, count] of Object.entries(counts)) console.log(`${source}: ${count}`);
const quarantined = quarantineMissing ? plans.filter((plan) => plan.source === "missing") : [];
if (counts.missing && !quarantineMissing) {
  throw new Error(`${counts.missing} poisoned artwork object(s) have no safe repair source.`);
}
const repairPlans = plans.filter((plan) => plan.source !== "missing");
if (!apply) {
  console.log("[DRY RUN] No R2 objects or repository files changed. Pass --apply after reviewing this plan.");
  process.exit(0);
}

mkdirSync(artworkDirectory, { recursive: true });
const prepared = [];
for (let index = 0; index < repairPlans.length; index += 1) {
  const plan = repairPlans[index];
  try {
    const image = plan.sourceUrl
      ? await downloadImage(plan.sourceUrl)
      : (() => {
        const bytes = readFileSync(plan.localFile);
        return { bytes, contentType: sniffContentType(bytes) };
      })();
    prepared.push({ ...plan, ...image, hash: md5(image.bytes) });
    if ((index + 1) % 25 === 0 || index + 1 === repairPlans.length) {
      console.log(`Prepared ${index + 1}/${repairPlans.length} replacement images.`);
    }
  } catch (error) {
    throw new Error(`${plan.song.id}: could not prepare ${plan.source} artwork: ${error.message}`);
  }
}

const currentBytes = [...initialObjects.values()].reduce((total, object) => total + object.size, 0);
const replacedBytes = prepared.reduce((total, image) => total + (initialObjects.get(image.key)?.size ?? 0), 0);
const replacementBytes = prepared.reduce((total, image) => total + image.bytes.length, 0);
const projectedBytes = currentBytes - replacedBytes + replacementBytes;
assertWithinR2Budget(projectedBytes, maxBytes);
console.log(`Projected R2 usage after repair: ${(projectedBytes / 1_000_000_000).toFixed(3)} GB.`);

const report = {
  repairedAt: new Date().toISOString(),
  poisonedEtag,
  songs: [],
  quarantined: quarantined.map((plan) => plan.song.id),
};
for (let index = 0; index < prepared.length; index += 1) {
  const image = prepared[index];
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: image.key,
    Body: image.bytes,
    ContentLength: image.bytes.length,
    ContentType: image.contentType,
    CacheControl: "public, max-age=86400",
    Metadata: { "songless-artwork-source": image.source, "songless-repair": "poisoned-checksum" },
  }));
  writeFileSync(image.localFile, image.bytes);
  image.song.media.artworkUrl = `${publicBaseUrl}/${image.key}?v=artfix-${image.hash.slice(0, 12)}`;
  report.songs.push({ id: image.song.id, key: image.key, source: image.source, md5: image.hash, bytes: image.bytes.length });
  if ((index + 1) % 25 === 0 || index + 1 === prepared.length) {
    console.log(`Uploaded ${index + 1}/${prepared.length} repaired images.`);
  }
}

for (const plan of quarantined) {
  delete plan.song.media.artworkUrl;
  plan.song.media.artworkStatus = "needs_canonical_artwork";
}

const verifiedObjects = await listObjects();
const verificationErrors = prepared.filter((image) => verifiedObjects.get(image.key)?.etag !== image.hash);
if (verificationErrors.length > 0) {
  throw new Error(`${verificationErrors.length} repaired R2 object(s) failed checksum verification.`);
}
const remainingPoisoned = candidateRoot.songs.filter((song) => (
  verifiedObjects.get(artworkKey(song))?.etag === poisonedEtag
  && referencesArtworkKey(song)
  && (includeNonLive || liveIds.has(song.id))
));
if (remainingPoisoned.length > 0) {
  throw new Error(`${remainingPoisoned.length} candidate artwork object(s) still use the poisoned checksum.`);
}

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Repaired and checksum-verified ${prepared.length} R2 artwork objects.`);
if (quarantined.length > 0) console.log(`Quarantined ${quarantined.length} unused poisoned artwork reference(s).`);
console.log(`Report: ${path.relative(root, reportFile)}`);
