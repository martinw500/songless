function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ").trim();
}

function collaborationBase(value = "") {
  return normalize(value).replace(/\b(?:feat(?:uring)?|ft|with)\b.*$/u, "").trim();
}

export function billionPriorityForCandidates(candidates, longlist) {
  const rankByTitle = new Map();
  for (const row of longlist.tracks ?? []) {
    if (!row.signals?.includes("billion_streams")) continue;
    for (const key of new Set([normalize(row.title), collaborationBase(row.title)])) {
      const rank = Number.isFinite(row.sourceRank) ? row.sourceRank : Number.MAX_SAFE_INTEGER;
      rankByTitle.set(key, Math.min(rankByTitle.get(key) ?? Number.MAX_SAFE_INTEGER, rank));
    }
  }

  return new Map(candidates.map((candidate) => {
    const keys = [candidate.title, ...(candidate.aliases ?? [])]
      .flatMap((title) => [normalize(title), collaborationBase(title)]);
    const rank = Math.min(...keys.map((key) => rankByTitle.get(key) ?? Number.MAX_SAFE_INTEGER));
    return [candidate.id, rank];
  }));
}

export function sortCandidatesBillionFirst(candidates, longlist) {
  const priority = billionPriorityForCandidates(candidates, longlist);
  return candidates.map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => (
      priority.get(left.candidate.id) - priority.get(right.candidate.id)
      || left.index - right.index
    ))
    .map(({ candidate }) => candidate);
}
