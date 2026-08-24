function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\b(?:feat|ft)\.?\b.*$/u, "")
    .replace(/[^a-z0-9]+/gu, " ").trim();
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

export const difficultyWeights = Object.freeze({
  introRecognition: 0.45,
  streamReach: 0.35,
  genZRelevance: 0.15,
  longevity: 0.05,
});

export const easeFormula = "0.45 * introRecognition + 0.35 * streamReach + 0.15 * genZRelevance + 0.05 * longevity";

export const provisionalDifficultyWeights = Object.freeze({
  audibilityProxy: 0.10,
  streamReach: 0.50,
  audienceFamiliarity: 0.20,
  genZRelevance: 0.15,
  longevity: 0.05,
});

export const provisionalEaseFormula = "0.10 * audibilityProxy + 0.50 * streamReach + 0.20 * audienceFamiliarity + 0.15 * genZRelevance + 0.05 * longevity";

function streamBillions(value) {
  const match = String(value ?? "").match(/([0-9.]+)\s*B/iu);
  return match ? Number(match[1]) : null;
}

function founderCohortScore(reason = "", signals = []) {
  const text = `${reason} ${signals.join(" ")}`;
  if (/current_global|current_social|current_gen_z|current_hit|current_pop|current_rnb|social_breakout/iu.test(text)) return 92;
  if (/gen_z|social_revival|social_viral/iu.test(text)) return 88;
  if (/childhood|cohort|nostalgia|iconic/iu.test(text)) return 86;
  if (/founder_recognition|explicit_(?:user_request|founder_keep|founder_pick)/iu.test(text)) return 86;
  if (/approved_under_1b|playlist_crossover/iu.test(text)) return 80;
  if (/famous_artist/iu.test(text)) return 72;
  return 72;
}

function inferredStreamScore(row) {
  const billions = streamBillions(row?.displayedStreams);
  if (billions !== null) {
    return round(55 + (Math.log10(clamp(billions, 1, 5.5)) / Math.log10(5.5)) * 45);
  }
  const reason = `${row?.founderReason ?? ""} ${(row?.signals ?? []).join(" ")}`;
  if (/current_global|current_hit|current_pop|current_rnb/iu.test(reason)) return 68;
  if (/social_breakout|social_viral|gen_z_staple|childhood_hit|cohort_hit/iu.test(reason)) return 58;
  if (/approved_under_1b|playlist_crossover|founder_recognition/iu.test(reason)) return 54;
  return 48;
}

function onsetScore(relativeAudibleMs) {
  if (relativeAudibleMs === null || relativeAudibleMs === undefined) return 15;
  if (relativeAudibleMs <= 150) return 100;
  if (relativeAudibleMs <= 500) return 100 - ((relativeAudibleMs - 150) / 350) * 10;
  if (relativeAudibleMs <= 2_000) return 90 - ((relativeAudibleMs - 500) / 1_500) * 30;
  if (relativeAudibleMs <= 5_000) return 60 - ((relativeAudibleMs - 2_000) / 3_000) * 30;
  if (relativeAudibleMs <= 15_000) return 30 - ((relativeAudibleMs - 5_000) / 10_000) * 25;
  return 5;
}

function introAudioScore(song, feature) {
  if (!feature) return 50;
  const startAtMs = song.startAtMs ?? song.media?.onsetPadMs ?? 30;
  const relativeAudibleMs = feature.firstAudibleMs === null ? null : Math.max(0, feature.firstAudibleMs - startAtMs);
  const gainDb = song.clueGainDb ?? 0;
  const introDb = (feature.first2SecondsDb ?? -60) + gainDb;
  const laterDb = (feature.seconds8To15Db ?? introDb) + gainDb;
  const energyScore = clamp(((introDb + 48) / 36) * 100);
  const rampPenalty = clamp((laterDb - introDb - 8) * 1.2, 0, 20);
  return round(clamp(onsetScore(relativeAudibleMs) * 0.55 + energyScore * 0.45 - rampPenalty));
}

export function difficultyFor(easeScore) {
  if (easeScore >= 82.6) return "easy";
  if (easeScore >= 79.2) return "medium";
  if (easeScore >= 75.9) return "hard";
  if (easeScore >= 72) return "expert";
  return "impossible";
}

export function provisionalDifficultyFor(easeScore) {
  if (easeScore >= 78.1) return "easy";
  if (easeScore >= 72.8) return "medium";
  if (easeScore >= 68.7) return "hard";
  if (easeScore >= 66.8) return "expert";
  return "impossible";
}

export function createScorer(longlist, featureRoot) {
  const rows = longlist.tracks ?? [];
  const features = new Map((featureRoot?.songs ?? []).map((feature) => [feature.id, feature]));
  const rowByKey = new Map(rows.map((row) => [`${normalize(row.title)}::${normalize(row.artist)}`, row]));

  function rowFor(song) {
    const exact = rowByKey.get(`${normalize(song.title)}::${normalize(song.artist)}`);
    if (exact) return exact;
    return rows.find((row) => normalize(row.title) === normalize(song.title)
      && (normalize(song.artist).includes(normalize(row.artist)) || normalize(row.artist).includes(normalize(song.artist))));
  }

  return (song) => {
    const row = rowFor(song);
    // Prefer a researched public stream milestone whenever one is available.
    // `broaderVisibility` remains the fallback for the hand-curated pilot, and
    // intake signals remain the fallback for newer/under-1B additions whose
    // exact totals have not been recorded yet.
    const streamReachScore = row?.displayedStreams
      ? inferredStreamScore(row)
      : song.scores
        ? song.scores.broaderVisibility
        : inferredStreamScore(row);
    const genZRelevanceScore = song.scores
      ? round(song.scores.audienceRecognition * 0.55 + song.scores.currentCirculation * 0.45)
      : founderCohortScore(row?.founderReason, row?.signals);
    const longevityScore = Number.isFinite(song.scores?.longevity)
      ? song.scores.longevity
      : 50;
    const recognitionWeight = difficultyWeights.streamReach
      + difficultyWeights.genZRelevance
      + difficultyWeights.longevity;
    const recognitionScore = round((
      streamReachScore * difficultyWeights.streamReach
      + genZRelevanceScore * difficultyWeights.genZRelevance
      + longevityScore * difficultyWeights.longevity
    ) / recognitionWeight);
    const estimatedIntroRecognition = introAudioScore(song, features.get(song.id));
    const reviewedIntro = Number.isFinite(song.introRecognition);
    const introRecognition = reviewedIntro
      ? song.introRecognition
      : estimatedIntroRecognition;
    const audienceFamiliarityScore = Number.isFinite(song.scores?.audienceRecognition)
      ? song.scores.audienceRecognition
      : Number.isFinite(song.familiarity)
        ? song.familiarity
        : recognitionScore;
    const easeScore = reviewedIntro
      ? round(
        introRecognition * difficultyWeights.introRecognition
        + streamReachScore * difficultyWeights.streamReach
        + genZRelevanceScore * difficultyWeights.genZRelevance
        + longevityScore * difficultyWeights.longevity,
      )
      : round(
        estimatedIntroRecognition * provisionalDifficultyWeights.audibilityProxy
        + streamReachScore * provisionalDifficultyWeights.streamReach
        + audienceFamiliarityScore * provisionalDifficultyWeights.audienceFamiliarity
        + genZRelevanceScore * provisionalDifficultyWeights.genZRelevance
        + longevityScore * provisionalDifficultyWeights.longevity,
      );
    return {
      streamReachScore,
      genZRelevanceScore,
      longevityScore,
      recognitionScore,
      audienceFamiliarityScore,
      introRecognition,
      estimatedIntroRecognition,
      introScoreMethod: reviewedIntro ? "reviewed" : "waveform_audibility_proxy_low_weight",
      easeScore,
      difficulty: reviewedIntro
        && song.proposedDifficulty
        && song.difficultyOverrideReason
        ? song.proposedDifficulty
        : reviewedIntro
          ? difficultyFor(easeScore)
          : provisionalDifficultyFor(easeScore),
    };
  };
}
