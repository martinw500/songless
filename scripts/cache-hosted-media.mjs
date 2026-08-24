import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const mediaRoot = path.join(root, "private-media", "r2");
const concurrency = Math.max(1, Math.min(8, Number(process.argv.find((value) => value.startsWith("--concurrency="))?.split("=")[1] ?? 4)));

const songs = JSON.parse(readFileSync(candidateFile, "utf8")).songs.filter((song) => (
  /^https:\/\//u.test(song.media?.hostedFullUrl ?? "")
  && /^https:\/\//u.test(song.media?.hostedClueUrl ?? "")
));

const jobs = [];
for (const song of songs) {
  for (const [kind, url] of [["full", song.media.hostedFullUrl], ["clues", song.media.hostedClueUrl]]) {
    const target = path.join(mediaRoot, kind, `${song.id}.mp3`);
    if (!existsSync(target)) jobs.push({ id: song.id, kind, target, url });
  }
}

mkdirSync(path.join(mediaRoot, "full"), { recursive: true });
mkdirSync(path.join(mediaRoot, "clues"), { recursive: true });

let cursor = 0;
let completed = 0;
let failed = 0;

async function download(job) {
  const temporary = `${job.target}.partial`;
  rmSync(temporary, { force: true });
  const response = await fetch(job.url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  renameSync(temporary, job.target);
}

async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    try {
      await download(job);
      completed += 1;
      console.log(`CACHED ${job.kind}/${job.id}.mp3 (${completed}/${jobs.length})`);
    } catch (error) {
      failed += 1;
      rmSync(`${job.target}.partial`, { force: true });
      console.error(`FAILED ${job.kind}/${job.id}.mp3: ${error.message}`);
    }
  }
}

console.log(`Hosted media: ${songs.length} songs; ${jobs.length} missing file(s); concurrency ${concurrency}.`);
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
console.log(`Cache complete: ${completed} downloaded; ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
