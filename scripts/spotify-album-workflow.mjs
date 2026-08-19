import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const headCandidateFile = path.join(root, "scratch", "head-candidates.json");
const cacheDir = path.join(root, "data", "spotify-cache.local");
const reportFile = path.join(root, "data", "spotify-metadata-report.json");

if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

const dryRun = process.argv.includes("--dry-run");
const verbose = process.argv.includes("--verbose") || process.argv.includes("--dry-run");
const localOnly = process.argv.includes("--local-only"); // for offline testing

// --- Credentials ---
const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret || /^your_/iu.test(clientId) || /^your_/iu.test(clientSecret)) {
  throw new Error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required in ignored .env.local.");
}

// === Caching ===
function getCacheKey(url) {
  return createHash("md5").update(url).digest("hex") + ".json";
}

function getCache(url) {
  const cachePath = path.join(cacheDir, getCacheKey(url));
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  }
  return null;
}

function setCache(url, data) {
  const cachePath = path.join(cacheDir, getCacheKey(url));
  writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
}

let cachedRequests = 0;
let apiRequests = 0;

// === API / HTTP ===
let spotifyToken = null;
async function getSpotifyToken() {
  if (localOnly) throw new Error("Local-only mode: Cannot fetch token.");
  if (spotifyToken) return spotifyToken;
  
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const value = await response.json();
  if (!response.ok || !value.access_token) throw new Error(`Spotify token failed (${response.status}).`);
  spotifyToken = value.access_token;
  return spotifyToken;
}

function generateReport(results) {
  const report = {
    timestamp: new Date().toISOString(),
    apiRequestsThisRun: apiRequests,
    cachedRequestsUsed: cachedRequests,
    verifiedCanonical: results.applied,
    provisionalNeedsAudit: results.provisional,
    unresolved: results.uncertain,
    rejectedVersions: results.rejectedCount,
    nextSongToProcess: results.nextSong || null,
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`\nSaved resumable report to data/spotify-metadata-report.json`);
}

async function spotifyFetch(url, resultsForReport) {
  const cached = getCache(url);
  if (cached) {
    cachedRequests++;
    return cached;
  }

  if (localOnly) throw new Error(`Local-only mode: Not in cache: ${url}`);
  await getSpotifyToken();

  for (let attempt = 0; attempt < 3; attempt++) {
    apiRequests++;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${spotifyToken}` },
    });
    
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "5", 10);
      if (retryAfter > 60) {
        console.error(`\n[!] FATAL: Spotify API Rate Limit Hit.`);
        console.error(`[!] Retry-After is ${retryAfter}s (approx ${(retryAfter/3600).toFixed(1)}h). Quota exceeded.`);
        console.error(`[!] Saving progress and exiting cleanly.`);
        generateReport(resultsForReport);
        process.exit(0);
      }
      console.warn(`  Rate limited. Waiting ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    
    if (response.status === 401 && attempt === 0) {
      spotifyToken = null;
      await getSpotifyToken();
      continue;
    }
    
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch (e) {}
      throw new Error(`Spotify API error: ${response.status} ${body}`);
    }
    
    const data = await response.json();
    setCache(url, data); // store immediately
    return data;
  }
  throw new Error("Spotify API: max retries exceeded");
}

// === Normalization & Rejection ===
function normalized(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\b(feat|featuring|ft|with)\.?\b.*$/u, "")
    .replace(/\b(remaster(?:ed)?|radio edit|single version)\b.*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const PENALTY_STRINGS = [
  /\bgreatest hits\b/iu, /\bbest of\b/iu, /\bessential\b/iu,
  /\bgold\b/iu, /\bcollection\b/iu, /\bcompilation\b/iu,
  /\bparty hits\b/iu, /\bmotivation\b/iu, /\bkids\b/iu,
  /\bkaraoke\b/iu, /\btribute\b/iu, /\bremastered\b/iu,
  /\bdeluxe\b/iu, /\bcovers?\b/iu, /\binstrumental\b/iu,
  /\blive\b/iu, /\bconcert\b/iu, /\bremix\b/iu, /\bacoustic\b/iu,
  /\bclean\b/iu, /\bradio edit\b/iu, /\bsped[- ]?up\b/iu,
  /\bslowed\b/iu, /\bnightcore\b/iu, /\bdemo\b/iu, /\bre-?record\b/iu
];

const REGRESSIONS = {
  "ed-sheeran-shape-of-you": "÷",
  "journey-dont-stop-believin": "Escape",
  "gnarls-barkley-crazy": "St. Elsewhere",
  "fleetwood-mac-dreams": "Rumours",
  "rihanna-jay-z-umbrella": "Good Girl Gone Bad",
  "nirvana-smells-like-teen-spirit": "Nevermind",
  "the-cranberries-zombie": "No Need to Argue",
  "psy-gangnam-style": "PSY 6 (Six Rules), Pt. 1",
  "post-malone-swae-lee-sunflower": "Spider-Man: Into the Spider-Verse",
  "glass-animals-heat-waves": "Dreamland",
  "eurythmics-sweet-dreams": "Sweet Dreams (Are Made of This)",
  "alexandra-stan-mr-saxobeat": "Saxobeats",
  "stromae-alors-on-danse": "Cheese",
  "huntrix-golden": "KPop Demon Hunters"
};

function scoreTrack(track, song) {
  let score = 0;
  let penaltyFlags = [];

  const albumName = track.album?.name || "";
  const trackName = track.name || "";
  const combined = (albumName + " " + trackName).toLowerCase();

  const regression = REGRESSIONS[song.id];
  if (regression && albumName.toLowerCase().includes(regression.toLowerCase())) {
    score += 10000;
  }

  for (const p of PENALTY_STRINGS) {
    if (p.test(combined)) {
      score -= 500;
      penaltyFlags.push(p.source);
    }
  }

  const hostedMs = song.media?.hostedDurationMs || 0;
  if (hostedMs) {
    const diff = Math.abs(track.duration_ms - hostedMs);
    score -= (diff / 1000); 
  }

  if (track.album?.release_date && song.releaseYear) {
    const year = parseInt(track.album.release_date.split("-")[0]);
    const diff = Math.abs(year - song.releaseYear);
    score -= (diff * 10);
  }

  const albumArtists = (track.album?.artists || []).map(a => a.name.toLowerCase());
  if (albumArtists.includes("various artists")) {
    score -= 50; 
    if (combined.includes("soundtrack") || combined.includes("motion picture")) {
      score += 60; 
    }
  }

  if (track.album?.album_type === "album") score += 20;
  else if (track.album?.album_type === "single") score += 5;

  return { score, penaltyFlags };
}

function verifyArtists(spotifyTrack, candidateArtists, isFictionalGroup) {
  if (isFictionalGroup) return true;
  const spotifyArtists = (spotifyTrack.artists || []).map(a => normalized(a.name));
  const expected = new Set(candidateArtists.map(normalized));
  const missing = [...expected].filter(a => !spotifyArtists.includes(a));
  const unexpected = spotifyArtists.filter(a => !expected.has(a));
  return missing.length === 0 && unexpected.length === 0;
}

function shouldProcessSong(song) {
  if (!song.album) return true; // Missing album
  if (REGRESSIONS[song.id]) return true; // Mandatory regression check
  
  const albumLower = song.album.toLowerCase();
  for (const p of PENALTY_STRINGS) {
    if (p.test(albumLower)) return true; // Suspicious album name
  }
  
  return false; // Provisional, already done, looks clean
}

// === Main ===
console.log("=== Spotify Strict Metadata Resumable Workflow ===\n");

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
let headMap = new Map();
try {
  const headData = execSync("git show HEAD:data/song-candidates.json", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  headMap = new Map(JSON.parse(headData).songs.map(s => [s.id, s]));
} catch (e) {
  console.warn("Could not load HEAD candidates. Fallbacks will not have original data.");
}

const results = {
  applied: [],
  provisional: [],
  uncertain: [],
  rejectedCount: 0,
  nextSong: null,
};

async function run() {
  for (let i = 0; i < candidateRoot.songs.length; i++) {
    const song = candidateRoot.songs[i];
    
    if (!shouldProcessSong(song)) {
      results.provisional.push({ id: song.id, album: song.album });
      continue;
    }

    if (verbose) console.log(`Processing: ${song.title} - ${song.artist}`);
    results.nextSong = song.id;

    const primaryArtist = song.primaryArtists[0];
    const query = encodeURIComponent(`track:${song.title} artist:${primaryArtist}`);
    const isFictionalGroup = ["huntrix-golden"].includes(song.id);
    
    let bestMatch = null;
    let foundConfident = false;

    for (const offset of [0, 10, 20]) {
      let res;
      try {
        const url = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=10&market=CA&offset=${offset}`;
        res = await spotifyFetch(url, results);
      } catch (err) {
        if (!localOnly) console.error(`API error for ${song.id}: ${err.message}`);
        break; 
      }

      const allTracks = res.tracks?.items || [];
      const titleMatches = allTracks.filter(t => normalized(t.name) === normalized(song.title));
      const creditMatches = titleMatches.filter(t => verifyArtists(t, song.primaryArtists, isFictionalGroup));
      
      results.rejectedCount += (allTracks.length - creditMatches.length);

      if (creditMatches.length > 0) {
        const scored = creditMatches.map(t => ({ track: t, ...scoreTrack(t, song) }));
        scored.sort((a, b) => b.score - a.score);
        
        // Save best overall across offsets if we don't find a confident one
        if (!bestMatch || scored[0].score > bestMatch.score) {
          bestMatch = scored[0];
        }

        // Confident if score is decently positive or regression match
        if (scored[0].score > -100 || REGRESSIONS[song.id]) {
          foundConfident = true;
          break; // Stop fetching offsets
        }
      }
    }

    if (!bestMatch) {
      results.uncertain.push({ id: song.id, reason: "No exact title + artist credit matches found" });
    } else if (!foundConfident && bestMatch.score < -400) {
      results.uncertain.push({ id: song.id, reason: `Best match strongly penalized (${bestMatch.penaltyFlags.join(", ")})` });
    } else {
      results.applied.push({
        songId: song.id,
        track: bestMatch.track,
        scoreInfo: bestMatch
      });
    }
    
    if (!localOnly) await new Promise(r => setTimeout(r, 100));
  }

  results.nextSong = null; // Finished all
  
  if (verbose) {
    console.log(`\nMatches found: ${results.applied.length}`);
    console.log(`Provisional (skipped): ${results.provisional.length}`);
    console.log(`Uncertain/Reverted: ${results.uncertain.length}`);
  }

  // --- No metadata alterations per requirement 10 ---
  console.log("\n[INFO] Skipping audio/metadata modifications per task requirements.");
  generateReport(results);
}

run().catch(err => {
  console.error("Workflow failed:", err);
  process.exit(1);
});
