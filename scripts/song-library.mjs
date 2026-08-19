import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const difficulties = ["easy", "medium", "hard", "expert", "impossible"];
const reviewStatuses = new Set(["needs_media", "needs_intro_review", "approved", "rejected"]);
const bucketTargets = {
  billion_anchor: 30,
  current_recent: 30,
  gen_z_staple: 30,
  classic_throwback: 20,
  global_crossover: 10,
};
const scoreKeys = ["audienceRecognition", "currentCirculation", "broaderVisibility", "longevity"];
const scoreWeights = {
  audienceRecognition: 0.4,
  currentCirculation: 0.25,
  broaderVisibility: 0.2,
  longevity: 0.15,
};
const easeWeights = { familiarity: 0.5, introRecognition: 0.5 };
const easeFormula = "0.5 * familiarity + 0.5 * introRecognition";

function argumentsFor(argv) {
  const result = { command: "audit" };
  const values = [...argv];
  if (values[0] && !values[0].startsWith("--")) result.command = values.shift();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--candidate-file") result.candidateFile = values[++index];
    else if (value === "--audio-dir") result.audioDirectory = values[++index];
    else if (value === "--artwork-dir") result.artworkDirectory = values[++index];
    else if (value === "--catalog-file") result.catalogFile = values[++index];
    else if (value === "--longlist-file") result.longlistFile = values[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function absolute(value, fallback) {
  return path.resolve(root, value ?? fallback);
}

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON from ${filename}: ${error.message}`);
  }
}

function familiarityFor(scores) {
  return Math.round(scoreKeys.reduce((total, key) => total + scores[key] * scoreWeights[key], 0));
}

function easeFor(familiarity, introRecognition) {
  return Math.round((easeWeights.familiarity * familiarity + easeWeights.introRecognition * introRecognition) * 10) / 10;
}

function suggestedDifficulty(easeScore) {
  if (easeScore >= 85) return "easy";
  if (easeScore >= 70) return "medium";
  if (easeScore >= 50) return "hard";
  if (easeScore >= 30) return "expert";
  return "impossible";
}

function eraFor(year) {
  if (year >= 2020) return "2020s";
  if (year >= 2010) return "2010s";
  if (year >= 2000) return "2000s";
  return "pre-2000";
}

function validateCandidateRoot(candidateRoot, audioDirectory, artworkDirectory) {
  const errors = [];
  const warnings = [];
  const songs = Array.isArray(candidateRoot?.songs) ? candidateRoot.songs : [];
  if (candidateRoot?.version !== 2) errors.push("Candidate file version must be 2.");
  if (songs.length !== 120) errors.push(`Candidate queue must contain 120 songs; found ${songs.length}.`);
  for (const key of scoreKeys) {
    if (candidateRoot?.scoring?.weights?.[key] !== scoreWeights[key]) errors.push(`Root scoring weight for ${key} is incorrect.`);
  }
  if (candidateRoot?.scoring?.easeFormula !== easeFormula) errors.push(`Root ease formula must be: ${easeFormula}.`);
  if (!Array.isArray(candidateRoot?.researchSources) || candidateRoot.researchSources.length === 0) {
    errors.push("Candidate file must record at least one research source.");
  }

  const ids = new Set();
  const recordings = new Set();
  const artistCounts = new Map();
  const bucketCounts = Object.fromEntries(Object.keys(bucketTargets).map((bucket) => [bucket, 0]));
  const eraCounts = { "2020s": 0, "2010s": 0, "2000s": 0, "pre-2000": 0 };
  const mediaCounts = { audio: 0, artwork: 0 };
  const statusCounts = {};
  const difficultyCounts = Object.fromEntries(difficulties.map((difficulty) => [difficulty, 0]));

  for (const [index, song] of songs.entries()) {
    const label = song?.id || `entry ${index + 1}`;
    const requiredStrings = ["id", "title", "artist", "language", "bucket", "reviewStatus"];
    for (const key of requiredStrings) {
      if (typeof song?.[key] !== "string" || !song[key].trim()) errors.push(`${label}: ${key} is required.`);
    }
    if (song?.id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(song.id)) errors.push(`${label}: id must be a lowercase URL slug.`);
    if (ids.has(song?.id)) errors.push(`${label}: duplicate id.`);
    ids.add(song?.id);

    if (!Array.isArray(song?.primaryArtists) || song.primaryArtists.length === 0) {
      errors.push(`${label}: primaryArtists must contain at least one artist.`);
    } else {
      for (const artist of new Set(song.primaryArtists)) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
      const recordingKey = `${song.title.toLocaleLowerCase()}::${[...song.primaryArtists].sort().join("|").toLocaleLowerCase()}`;
      if (recordings.has(recordingKey)) errors.push(`${label}: duplicate title and artist credit.`);
      recordings.add(recordingKey);
    }
    for (const key of ["aliases", "artistAliases", "genres", "selectionSignals"]) {
      if (!Array.isArray(song?.[key])) errors.push(`${label}: ${key} must be an array.`);
    }
    if (Array.isArray(song?.genres) && song.genres.length === 0) errors.push(`${label}: genres cannot be empty.`);
    if (Array.isArray(song?.selectionSignals) && song.selectionSignals.length === 0) errors.push(`${label}: selectionSignals cannot be empty.`);
    if (typeof song?.language === "string" && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(song.language)) {
      errors.push(`${label}: language must be a short BCP 47 code such as en, fr, or pt-BR.`);
    }
    if (song?.album !== undefined && (typeof song.album !== "string" || !song.album.trim())) {
      errors.push(`${label}: album must be a non-empty string when supplied.`);
    }
    if (song?.spotifyUrl !== undefined && (typeof song.spotifyUrl !== "string" || !/^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+(?:\?.*)?$/.test(song.spotifyUrl))) {
      errors.push(`${label}: spotifyUrl must be an open.spotify.com track URL.`);
    }
    if (song?.startAtMs !== undefined && (!Number.isInteger(song.startAtMs) || song.startAtMs < 0)) {
      errors.push(`${label}: startAtMs must be a non-negative integer when supplied.`);
    }
    if (!reviewStatuses.has(song?.reviewStatus)) errors.push(`${label}: unknown reviewStatus ${song?.reviewStatus}.`);
    if (!Number.isInteger(song?.releaseYear) || song.releaseYear < 1900 || song.releaseYear > 2026) {
      errors.push(`${label}: releaseYear must be between 1900 and 2026.`);
    } else {
      eraCounts[eraFor(song.releaseYear)] += 1;
    }
    if (!(song?.bucket in bucketTargets)) errors.push(`${label}: unknown bucket ${song?.bucket}.`);
    else bucketCounts[song.bucket] += 1;

    if (!song?.scores || typeof song.scores !== "object") {
      errors.push(`${label}: scores are required.`);
    } else {
      for (const key of scoreKeys) {
        if (!Number.isInteger(song.scores[key]) || song.scores[key] < 0 || song.scores[key] > 100) {
          errors.push(`${label}: scores.${key} must be an integer from 0 to 100.`);
        }
      }
      if (scoreKeys.every((key) => Number.isInteger(song.scores[key]))) {
        const expectedFamiliarity = familiarityFor(song.scores);
        if (song.familiarity !== expectedFamiliarity) {
          errors.push(`${label}: familiarity must be ${expectedFamiliarity}; found ${song.familiarity}.`);
        }
      }
    }

    const hasIntro = Number.isFinite(song?.introRecognition);
    if (song?.introRecognition !== null && (!hasIntro || song.introRecognition < 0 || song.introRecognition > 100)) {
      errors.push(`${label}: introRecognition must be null or a number from 0 to 100.`);
    }
    if (hasIntro) {
      const expectedEase = easeFor(song.familiarity, song.introRecognition);
      if (song.easeScore !== expectedEase) errors.push(`${label}: easeScore must be ${expectedEase}; found ${song.easeScore}.`);
      const suggested = suggestedDifficulty(expectedEase);
      if (!difficulties.includes(song.proposedDifficulty)) errors.push(`${label}: a scored intro needs a proposedDifficulty.`);
      if (song.proposedDifficulty !== suggested && !song.difficultyOverrideReason) {
        errors.push(`${label}: difficulty override from ${suggested} needs difficultyOverrideReason.`);
      }
    } else if (song?.easeScore !== null || song?.proposedDifficulty !== null) {
      errors.push(`${label}: easeScore and proposedDifficulty must remain null until the intro is reviewed.`);
    }

    if (!song?.media || song.media.audioFile !== `${song.id}.mp3` || song.media.artworkFile !== `${song.id}.jpg`) {
      errors.push(`${label}: media filenames must match the candidate id.`);
    } else {
      const hasLocalAudio = existsSync(path.join(audioDirectory, song.media.audioFile));
      const hasHostedAudio = typeof song.media.hostedClueUrl === "string"
        && /^https:\/\//.test(song.media.hostedClueUrl)
        && typeof song.media.hostedFullUrl === "string"
        && /^https:\/\//.test(song.media.hostedFullUrl)
        && Number.isInteger(song.media.hostedDurationMs)
        && song.media.hostedDurationMs >= 15_000;
      if (song.media.artworkUrl !== undefined && (typeof song.media.artworkUrl !== "string" || !/^https:\/\//.test(song.media.artworkUrl))) {
        errors.push(`${label}: media.artworkUrl must be an HTTPS URL.`);
      }
      if ((song.media.hostedClueUrl !== undefined || song.media.hostedFullUrl !== undefined || song.media.hostedDurationMs !== undefined) && !hasHostedAudio) {
        errors.push(`${label}: hosted media needs HTTPS clue/full URLs and durationMs of at least 15000.`);
      }
      if (hasHostedAudio && Number.isInteger(song.startAtMs)
        && song.startAtMs + 15_000 > song.media.hostedDurationMs) {
        errors.push(`${label}: startAtMs must leave at least 15 seconds of hosted playback.`);
      }
      const hasAudio = hasLocalAudio || hasHostedAudio;
      if (hasAudio) mediaCounts.audio += 1;
      if (existsSync(path.join(artworkDirectory, song.media.artworkFile)) || song.media.artworkUrl) mediaCounts.artwork += 1;
      if (song.reviewStatus === "needs_intro_review" && !hasAudio) errors.push(`${label}: intro review requires its audio file.`);
      if (song.reviewStatus === "needs_media" && hasAudio) warnings.push(`${label}: audio is ready; advance it to needs_intro_review.`);
    }
    statusCounts[song?.reviewStatus] = (statusCounts[song?.reviewStatus] ?? 0) + 1;
    if (song?.reviewStatus === "approved") {
      if (!hasIntro || !difficulties.includes(song.proposedDifficulty)) errors.push(`${label}: approved candidates need an intro score and difficulty.`);
      else difficultyCounts[song.proposedDifficulty] += 1;
      const hasPlayableMedia = existsSync(path.join(audioDirectory, song.media.audioFile))
        || (typeof song.media.hostedClueUrl === "string" && /^https:\/\//.test(song.media.hostedClueUrl)
          && typeof song.media.hostedFullUrl === "string" && /^https:\/\//.test(song.media.hostedFullUrl)
          && Number.isInteger(song.media.hostedDurationMs));
      if (!hasPlayableMedia) errors.push(`${label}: approved candidate is missing playable audio.`);
    }
  }

  for (const [bucket, target] of Object.entries(bucketTargets)) {
    if (bucketCounts[bucket] !== target) errors.push(`${bucket} must contain ${target} songs; found ${bucketCounts[bucket]}.`);
  }
  for (const [artist, count] of artistCounts) {
    if (count > 3) errors.push(`${artist} appears on ${count} songs; the maximum is 3.`);
  }
  const eraTargets = { "2020s": 42, "2010s": 42, "2000s": 18, "pre-2000": 18 };
  for (const [era, target] of Object.entries(eraTargets)) {
    if (Math.abs(eraCounts[era] - target) > 5) warnings.push(`${era} has ${eraCounts[era]} songs; the rough target is ${target}.`);
  }

  return { errors, warnings, songs, bucketCounts, eraCounts, artistCounts, mediaCounts, statusCounts, difficultyCounts };
}

function validateLiveCatalog(report, catalogFile, audioDirectory) {
  const catalog = readJson(catalogFile);
  const counts = Object.fromEntries(difficulties.map((difficulty) => [difficulty, 0]));
  let demoCount = 0;
  let realCount = 0;
  const ids = new Set();
  const candidates = new Map(report.songs.map((song) => [song.id, song]));
  if (!Array.isArray(catalog)) {
    report.errors.push("Live catalogue must be a JSON array.");
    return;
  }
  for (const song of catalog) {
    const label = song?.id ?? "live catalogue entry";
    if (!song?.id || !song?.title || !song?.artist || !difficulties.includes(song?.difficulty)) {
      report.errors.push(`${label}: live catalogue metadata is incomplete.`);
      continue;
    }
    if (ids.has(song.id)) report.errors.push(`${label}: duplicate live catalogue id.`);
    ids.add(song.id);
    counts[song.difficulty] += 1;
    if (song?.audio?.kind === "synth") {
      demoCount += 1;
      continue;
    }
    if (!new Set(["file", "hosted"]).has(song?.audio?.kind)) {
      report.errors.push(`${label}: live audio must be a synth demo, file, or hosted source.`);
      continue;
    }
    if (song.audio.kind === "file" && typeof song.audio.src !== "string") report.errors.push(`${label}: live file audio needs src.`);
    if (song.audio.kind === "hosted" && (!/^https:\/\//.test(song.audio.clueSrc ?? "")
      || !/^https:\/\//.test(song.audio.fullSrc ?? "") || !Number.isInteger(song.audio.durationMs))) {
      report.errors.push(`${label}: live hosted audio needs HTTPS clue/full URLs and durationMs.`);
    }
    if (!Number.isInteger(song.startAtMs) || song.startAtMs < 0) {
      report.errors.push(`${label}: live startAtMs must be a non-negative integer.`);
    }
    realCount += 1;
    const candidate = candidates.get(song.id);
    if (!candidate || candidate.reviewStatus !== "approved") {
      report.errors.push(`${label}: real live song is not an approved candidate.`);
      continue;
    }
    if (song.difficulty !== candidate.proposedDifficulty) report.errors.push(`${label}: live difficulty disagrees with its approved candidate.`);
    if (song.startAtMs !== (candidate.startAtMs ?? 0)) report.errors.push(`${label}: live startAtMs disagrees with its approved candidate.`);
    if (song.audio.kind === "file" && !existsSync(path.join(audioDirectory, candidate.media.audioFile))) report.errors.push(`${label}: live audio file is missing.`);
  }
  if (realCount > 0) {
    if (demoCount > 0) report.errors.push("Demo and real songs cannot be mixed in the promoted live catalogue.");
    for (const difficulty of difficulties) {
      if (counts[difficulty] < 10) report.errors.push(`Live catalogue requires 10 ${difficulty} songs; found ${counts[difficulty]}.`);
    }
  }
  report.liveCounts = counts;
  report.liveDemoCount = demoCount;
  report.liveRealCount = realCount;
}

function validateLonglist(report, longlistFile) {
  if (!existsSync(longlistFile)) {
    report.errors.push(`Longlist snapshot is missing: ${longlistFile}`);
    return;
  }
  const root = readJson(longlistFile);
  const tracks = Array.isArray(root?.tracks) ? root.tracks : [];
  if (root?.version !== 1 || root?.status !== "intake_longlist") report.errors.push("Longlist version or status is invalid.");
  if (tracks.length < 500) report.errors.push(`Longlist should remain a broad intake pool; found only ${tracks.length} tracks.`);
  const ranks = new Set();
  let billionCount = 0;
  let founderCount = 0;
  let personalCount = 0;
  let reviewedKeepCount = 0;
  const languageCounts = {};
  for (const [index, track] of tracks.entries()) {
    const label = track?.title || `longlist entry ${index + 1}`;
    if (typeof track?.title !== "string" || typeof track?.artist !== "string") report.errors.push(`${label}: longlist title and artist are required.`);
    if (!Array.isArray(track?.signals) || track.signals.length === 0) report.errors.push(`${label}: longlist signals are required.`);
    if (!new Set(["pending", "english", "non_english", "multilingual"]).has(track?.languageReview)) {
      report.errors.push(`${label}: invalid languageReview.`);
    }
    if (!new Set(["unreviewed", "shortlisted", "rejected"]).has(track?.reviewStatus)) {
      report.errors.push(`${label}: invalid longlist reviewStatus.`);
    }
    if (track?.signals?.includes("billion_streams")) {
      billionCount += 1;
      if (!Number.isInteger(track.sourceRank) || track.sourceRank < 1) report.errors.push(`${label}: billion-stream row needs a sourceRank.`);
      if (ranks.has(track.sourceRank)) report.errors.push(`${label}: duplicate sourceRank ${track.sourceRank}.`);
      ranks.add(track.sourceRank);
      if (typeof track.displayedStreams !== "string" || !/^\d+(?:\.\d+)?B$/.test(track.displayedStreams)) {
        report.errors.push(`${label}: displayedStreams must use the source's billion format.`);
      }
    }
    if (track?.signals?.includes("founder_pick")) founderCount += 1;
    if (track?.signals?.includes("personal_playlist")) personalCount += 1;
    if (track?.signals?.includes("reviewed_keep")) reviewedKeepCount += 1;
    if (track?.reviewStatus === "rejected" || track?.rejectionReason) report.errors.push(`${label}: pruned tracks must not remain in the active longlist.`);
    languageCounts[track?.languageReview] = (languageCounts[track?.languageReview] ?? 0) + 1;
  }
  if (!Number.isInteger(root?.counts?.billionSnapshot) || root.counts.billionSnapshot < billionCount) {
    report.errors.push("Longlist billionSnapshot count is invalid.");
  }
  if (root?.counts?.billionIncluded !== billionCount) report.errors.push("Longlist billionIncluded count is stale.");
  if (root?.counts?.founderPicks !== founderCount) report.errors.push("Longlist founderPicks count is stale.");
  if (root?.counts?.personalPlaylist !== personalCount) report.errors.push("Longlist personalPlaylist count is stale.");
  if (root?.counts?.reviewedKeeps !== reviewedKeepCount) report.errors.push("Longlist reviewedKeeps count is stale.");
  if (!Number.isInteger(root?.counts?.excludedByCurrentDecisions) || root.counts.excludedByCurrentDecisions < 0) {
    report.errors.push("Longlist excludedByCurrentDecisions count is invalid.");
  }
  if (root?.counts?.active !== tracks.length) report.errors.push("Longlist active count is stale.");
  if (root?.counts?.combinedUnique !== tracks.length) report.errors.push("Longlist combinedUnique count is stale.");
  if (!Number.isInteger(root?.counts?.finalizedExclusions) || root.counts.finalizedExclusions < 0) {
    report.errors.push("Longlist finalizedExclusions count is invalid.");
  }
  report.longlistCounts = {
    total: tracks.length,
    sourceBillion: root?.counts?.billionSnapshot,
    billion: billionCount,
    founder: founderCount,
    personal: personalCount,
    reviewedKeeps: reviewedKeepCount,
    finalized: root?.counts?.finalizedExclusions,
    excludedCurrent: root?.counts?.excludedByCurrentDecisions,
    active: tracks.length,
    languages: languageCounts,
  };
}

function printAudit(report) {
  console.log(`Candidates: ${report.songs.length}`);
  console.log(`Buckets: ${Object.entries(report.bucketCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`Eras: ${Object.entries(report.eraCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`Media ready: audio=${report.mediaCounts.audio}, artwork=${report.mediaCounts.artwork}`);
  console.log(`Media missing: audio=${report.songs.length - report.mediaCounts.audio}, artwork=${report.songs.length - report.mediaCounts.artwork} (artwork optional)`);
  console.log(`Statuses: ${Object.entries(report.statusCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`Approved difficulties: ${Object.entries(report.difficultyCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`Live catalogue: demos=${report.liveDemoCount}, real=${report.liveRealCount}; ${Object.entries(report.liveCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  if (report.longlistCounts) {
    console.log(`Intake longlist: total=${report.longlistCounts.total}, active=${report.longlistCounts.active}, current-excluded=${report.longlistCounts.excludedCurrent}, finalized=${report.longlistCounts.finalized}, billion-included=${report.longlistCounts.billion}/${report.longlistCounts.sourceBillion}, founder=${report.longlistCounts.founder}, personal=${report.longlistCounts.personal}, reviewed-keeps=${report.longlistCounts.reviewedKeeps}; languages ${Object.entries(report.longlistCounts.languages).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
  if (report.warnings.length) console.warn(`Warnings:\n- ${report.warnings.join("\n- ")}`);
  if (report.errors.length) console.error(`Errors:\n- ${report.errors.join("\n- ")}`);
  else console.log("Song library audit passed.");
}

function promote(report, catalogFile, audioDirectory, artworkDirectory) {
  if (report.errors.length) throw new Error("Promotion stopped because the candidate audit failed.");
  const approved = report.songs.filter((song) => song.reviewStatus === "approved");
  for (const difficulty of difficulties) {
    const count = approved.filter((song) => song.proposedDifficulty === difficulty).length;
    if (count < 10) throw new Error(`Promotion requires 10 approved songs in ${difficulty}; found ${count}.`);
  }
  const catalog = approved.map((song) => {
    const artworkPath = path.join(artworkDirectory, song.media.artworkFile);
    const artwork = existsSync(artworkPath)
      ? `/media/artwork/${song.media.artworkFile}`
      : song.media.artworkUrl;
    const audio = song.media.hostedClueUrl
      ? {
          kind: "hosted",
          clueSrc: song.media.hostedClueUrl,
          fullSrc: song.media.hostedFullUrl,
          durationMs: song.media.hostedDurationMs,
        }
      : { kind: "file", src: `/media/audio/${song.media.audioFile}` };
    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      aliases: song.aliases,
      artistAliases: song.artistAliases,
      ...(song.album ? { album: song.album } : {}),
      ...(song.spotifyUrl ? { spotifyUrl: song.spotifyUrl } : {}),
      releaseYear: song.releaseYear,
      genres: song.genres,
      difficulty: song.proposedDifficulty,
      familiarity: song.familiarity,
      introRecognition: song.introRecognition,
      startAtMs: song.startAtMs ?? 0,
      ...(artwork ? { artwork } : {}),
      audio,
    };
  });
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(`Promoted ${catalog.length} songs to ${catalogFile}.`);
}

const options = argumentsFor(process.argv.slice(2));
if (!new Set(["audit", "promote"]).has(options.command)) throw new Error(`Unknown command: ${options.command}`);
const candidateFile = absolute(options.candidateFile, "data/song-candidates.json");
const audioDirectory = absolute(options.audioDirectory, "public/media/audio");
const artworkDirectory = absolute(options.artworkDirectory, "public/media/artwork");
const catalogFile = absolute(options.catalogFile, "public/catalog.json");
const longlistFile = absolute(options.longlistFile, "data/song-longlist.json");
const report = validateCandidateRoot(readJson(candidateFile), audioDirectory, artworkDirectory);
validateLiveCatalog(report, catalogFile, audioDirectory);
validateLonglist(report, longlistFile);
printAudit(report);
if (options.command === "promote") promote(report, catalogFile, audioDirectory, artworkDirectory);
if (report.errors.length) process.exitCode = 1;
