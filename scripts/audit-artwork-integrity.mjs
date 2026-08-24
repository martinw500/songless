import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const catalogFile = path.join(root, "public", "catalog.json");
const artworkDirectory = path.join(root, "private-media", "r2", "artwork");
const sharingOverridesFile = path.join(root, "data", "artwork-sharing-overrides.json");
const checkRemote = process.argv.includes("--remote");
const compareLocal = process.argv.includes("--compare-local");

const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs;
const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
const sharingOverrides = existsSync(sharingOverridesFile)
  ? JSON.parse(readFileSync(sharingOverridesFile, "utf8")).groups ?? []
  : [];
const errors = [];
const warnings = [];

function artworkKey(url) {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function md5(file) {
  return createHash("md5").update(readFileSync(file)).digest("hex");
}

function isDocumentedSharedArtwork(songs) {
  const actualIds = songs.map((song) => song.id).sort();
  return sharingOverrides.some((override) => {
    const overrideIds = [...(override.ids ?? [])].sort();
    return override.reason?.trim()
      && actualIds.length === overrideIds.length
      && actualIds.every((id, index) => id === overrideIds[index]);
  });
}

for (const song of candidates) {
  const key = artworkKey(song.media?.artworkUrl);
  const expected = `artwork/${song.id}.jpg`;
  if (song.media?.artworkUrl && !key) errors.push(`${song.id}: invalid artwork URL`);
  else if (key && key !== expected) errors.push(`${song.id}: artwork key is ${key}; expected ${expected}`);
}

for (const song of catalog) {
  const key = artworkKey(song.artwork);
  const expected = `artwork/${song.id}.jpg`;
  if (!key) errors.push(`catalog ${song.id}: missing or invalid artwork URL`);
  else if (key !== expected) errors.push(`catalog ${song.id}: artwork key is ${key}; expected ${expected}`);
}

const localFiles = existsSync(artworkDirectory)
  ? readdirSync(artworkDirectory).filter((file) => /\.(?:jpe?g|png|webp)$/iu.test(file))
  : [];
const localByKey = new Map(localFiles.map((file) => {
  const fullPath = path.join(artworkDirectory, file);
  return [`artwork/${file}`, { hash: md5(fullPath), size: statSync(fullPath).size }];
}));

const candidateById = new Map(candidates.map((song) => [song.id, song]));
const localHashGroups = new Map();
for (const [key, value] of localByKey) {
  const id = path.basename(key, path.extname(key));
  const song = candidateById.get(id);
  if (!localHashGroups.has(value.hash)) localHashGroups.set(value.hash, []);
  localHashGroups.get(value.hash).push({ id, album: song?.album ?? null });
}
if (compareLocal) {
  for (const group of localHashGroups.values()) {
    const albums = new Set(group.map((entry) => entry.album).filter(Boolean));
    if (group.length > 1 && albums.size > 1) {
      warnings.push(`identical local image used for different albums: ${group.map((entry) => `${entry.id} (${entry.album ?? "unknown"})`).join(", ")}`);
    }
  }
}

if (checkRemote) {
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
  for (const name of required) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required in ignored .env.local for --remote.`);
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const remoteByKey = new Map();
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      ContinuationToken: continuationToken,
      Prefix: "artwork/",
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      remoteByKey.set(object.Key, {
        etag: object.ETag?.replaceAll('"', "").toLowerCase() ?? null,
        size: object.Size ?? null,
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  const remoteHashGroups = new Map();
  for (const song of candidates.filter((candidate) => candidate.media?.artworkUrl)) {
    const key = artworkKey(song.media.artworkUrl);
    const remote = key ? remoteByKey.get(key) : null;
    if (!remote?.etag) continue;
    if (!remoteHashGroups.has(remote.etag)) remoteHashGroups.set(remote.etag, []);
    remoteHashGroups.get(remote.etag).push(song);
  }
  const suspiciousRemoteGroups = [...remoteHashGroups.entries()]
    .map(([etag, songs]) => ({ etag, songs, albums: new Set(songs.map((song) => song.album).filter(Boolean)) }))
    .filter((group) => group.songs.length > 1
      && (group.albums.size > 1 || group.songs.length > 3)
      && !isDocumentedSharedArtwork(group.songs))
    .sort((left, right) => right.songs.length - left.songs.length);
  for (const group of suspiciousRemoteGroups) {
    errors.push(`R2 checksum ${group.etag} is shared by ${group.songs.length} songs across ${group.albums.size} albums: ${group.songs.slice(0, 12).map((song) => song.id).join(", ")}${group.songs.length > 12 ? ", ..." : ""}`);
  }

  for (const song of catalog) {
    const key = artworkKey(song.artwork);
    const remote = key ? remoteByKey.get(key) : null;
    if (!remote) {
      errors.push(`catalog ${song.id}: ${key ?? "artwork"} is missing from R2`);
      continue;
    }
    if (compareLocal) {
      const local = localByKey.get(key);
      if (!local) {
        warnings.push(`${song.id}: no local artwork copy available for byte verification`);
        continue;
      }
      if (remote.etag && !remote.etag.includes("-") && remote.etag !== local.hash) {
        errors.push(`${song.id}: R2 content differs from local artwork (${remote.etag} != ${local.hash})`);
      }
      if (remote.size !== null && remote.size !== local.size) {
        errors.push(`${song.id}: R2 size differs from local artwork (${remote.size} != ${local.size})`);
      }
    }
  }
  console.log(`Remote artwork objects: ${remoteByKey.size}`);
}

console.log(`Candidate artwork records: ${candidates.length}`);
console.log(`Live catalogue artwork records: ${catalog.length}`);
console.log(`Local artwork files: ${localByKey.size}`);
for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);
console.log(`Artwork integrity: ${errors.length} error(s), ${warnings.length} warning(s).`);
if (errors.length > 0) process.exitCode = 1;
