import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { languageReviewFor, parseFounderPlaylistExport } from "./song-longlist-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceUrl = "https://tooxclusive.com/stats/milestones/songs/1-billion-streams";
const officialPlaylistUrl = "https://open.spotify.com/playlist/37i9dQZF1DX7iB3RCnBnN4";
const snapshotFile = path.join(root, "data", "song-longlist.json");
const textFile = path.join(root, "data", "song-longlist.txt");
const manualFile = path.join(root, "data", "song-manual-additions.json");
const baselineFile = path.join(root, "data", "song-longlist-baseline.json");
const finalizedPassFiles = [path.join(root, "data", "song-longlist-finalized-pass-4.json")];
const keepsFile = path.join(root, "data", "song-longlist-keeps.json");
const decisionsFile = path.join(root, "data", "song-longlist-decisions.json");
const founderPlaylistUrl = "https://open.spotify.com/embed/playlist/0LF0dYuWf8Vl0ZjRHeix3J";
const founderPlaylistExportFile = path.join(root, "data", "founder-playlist-export.csv");

function decodeHtml(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return named[entity.toLowerCase()] ?? `&${entity};`;
    })
    .replace(/<!-- -->/g, "")
    .trim();
}

function normalized(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(feat|featuring|ft|with)\.?\b.*$/g, "")
    .replace(/\b(remaster(?:ed)?|radio edit|single version|explicit ver)\b.*$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedDecisionTitle(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function likelySameArtist(left, right) {
  const leftName = normalized(left);
  const rightName = normalized(right);
  return leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName);
}

function parsePage(html) {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!body) throw new Error("The source page did not contain a song table.");
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
    const row = match[1];
    const rank = Number(row.match(/<td[^>]*text-right[^>]*>(\d+)<\/td>/i)?.[1]);
    const labels = [...row.matchAll(/<p class="[^"]*">([\s\S]*?)<\/p>/gi)].map((label) => decodeHtml(label[1]));
    const streams = decodeHtml(row.match(/<td class="[^"]*font-semibold[^"]*">([\s\S]*?)<\/td>/i)?.[1] ?? "");
    if (!rank || labels.length < 2 || !streams) throw new Error(`Could not parse a source row near rank ${rank || "unknown"}.`);
    return { sourceRank: rank, title: labels[0], artist: labels[1], displayedStreams: streams };
  });
}

function parseFounderPlaylist(html) {
  return [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3><h4[^>]*>([\s\S]*?)<\/h4>/gi)]
    .map((match) => ({
      title: decodeHtml(match[1]).replace(/\s+/g, " "),
      artist: decodeHtml(match[2]).replace(/^E(?=[A-Z])/u, "").replace(/\s+/g, " "),
    }))
    .filter((track) => !/[\p{Script=Han}]/u.test(`${track.title} ${track.artist}`));
}

async function fetchPage(page) {
  const response = await fetch(`${sourceUrl}?page=${page}`, { headers: { "user-agent": "Songless research snapshot" } });
  if (!response.ok) throw new Error(`Longlist source page ${page} failed (${response.status}).`);
  return response.text();
}

const firstHtml = await fetchPage(1);
const totalPages = Number(firstHtml.match(/Page(?:<!-- -->|\s)*1(?:<!-- -->|\s)*of(?:<!-- -->|\s)*(\d+)/i)?.[1]);
if (!totalPages) throw new Error("Could not determine the longlist page count.");
const pages = [firstHtml];
for (let page = 2; page <= totalPages; page += 1) pages.push(await fetchPage(page));
const billionTracks = pages.flatMap(parsePage).sort((a, b) => a.sourceRank - b.sourceRank);
if (billionTracks.length < 500) throw new Error(`Expected a large billion-stream snapshot; found only ${billionTracks.length}.`);
let founderPlaylistTracks;
let founderPlaylistSource;
if (existsSync(founderPlaylistExportFile)) {
  founderPlaylistTracks = parseFounderPlaylistExport(readFileSync(founderPlaylistExportFile, "utf8"));
  founderPlaylistSource = { label: "Founder playlist full export", file: "data/founder-playlist-export.csv" };
} else {
  const founderPlaylistResponse = await fetch(founderPlaylistUrl, { headers: { "user-agent": "Songless founder playlist research" } });
  if (!founderPlaylistResponse.ok) throw new Error(`Founder playlist failed (${founderPlaylistResponse.status}).`);
  founderPlaylistTracks = parseFounderPlaylist(await founderPlaylistResponse.text());
  founderPlaylistSource = { label: "Founder playlist 100-track public preview", url: founderPlaylistUrl };
}
if (founderPlaylistTracks.length === 0) throw new Error("Founder playlist did not expose any tracks.");

const manualRoot = JSON.parse(readFileSync(manualFile, "utf8"));
if (!Array.isArray(manualRoot.tracks)) throw new Error("Manual additions file needs a tracks array.");
const latestBatchStart = manualRoot.latestBatch?.startsAt
  ? manualRoot.tracks.findIndex((track) => normalizedDecisionTitle(track.title) === normalizedDecisionTitle(manualRoot.latestBatch.startsAt))
  : -1;
if (manualRoot.latestBatch && latestBatchStart < 0) throw new Error("Manual additions latestBatch start title was not found.");
const tracks = billionTracks.map((track) => ({
  ...track,
  signals: ["billion_streams"],
  languageReview: "pending",
  reviewStatus: "unreviewed",
}));

for (const [manualIndex, manual] of manualRoot.tracks.entries()) {
  const manualLanguageReview = languageReviewFor(manual.languageReview);
  const manualSignals = [...(manual.signals ?? [])];
  if (latestBatchStart >= 0 && manualIndex >= latestBatchStart && !manualSignals.includes(manualRoot.latestBatch.id)) {
    manualSignals.push(manualRoot.latestBatch.id);
  }
  const existing = tracks.find((track) => normalized(track.title) === normalized(manual.title) && likelySameArtist(track.artist, manual.artist));
  if (existing) {
    if (!existing.signals.includes("founder_pick")) existing.signals.push("founder_pick");
    for (const signal of manualSignals) {
      if (!existing.signals.includes(signal)) existing.signals.push(signal);
    }
    existing.founderReason = manual.reason;
    existing.languageReview = manualLanguageReview;
  } else {
    tracks.push({
      sourceRank: null,
      title: manual.title,
      artist: manual.artist,
      displayedStreams: null,
      signals: ["founder_pick", ...manualSignals],
      founderReason: manual.reason,
      languageReview: manualLanguageReview,
      reviewStatus: "unreviewed",
    });
  }
}

for (const personal of founderPlaylistTracks) {
  const existing = tracks.find((track) => normalized(track.title) === normalized(personal.title) && likelySameArtist(track.artist, personal.artist));
  if (existing) {
    if (!existing.signals.includes("personal_playlist")) existing.signals.push("personal_playlist");
  }
}

function applyDecisionRoot(targetTracks, decisionRoot, strictTitles = false) {
  const rejectedArtists = Array.isArray(decisionRoot.rejectedArtists) ? decisionRoot.rejectedArtists : [];
  const trackDecisions = Array.isArray(decisionRoot.trackDecisions) ? decisionRoot.trackDecisions : [];
  for (const track of targetTracks) {
  for (const rule of rejectedArtists) {
    if (!likelySameArtist(track.artist, rule.artist)) continue;
    const excepted = (rule.exceptTitles ?? []).some((title) => normalized(title) === normalized(track.title));
    if (!excepted) {
      track.reviewStatus = "rejected";
      track.rejectionReason = rule.reason;
    }
  }
  const explicit = trackDecisions.find((decision) => {
    const titlesMatch = strictTitles
      ? normalizedDecisionTitle(decision.title) === normalizedDecisionTitle(track.title)
      : normalized(decision.title) === normalized(track.title);
    return titlesMatch && likelySameArtist(track.artist, decision.artist);
  });
  if (explicit) {
    for (const signal of explicit.signals ?? []) {
      if (!track.signals.includes(signal)) track.signals.push(signal);
    }
    track.reviewStatus = explicit.decision;
    if (explicit.languageReview !== undefined) {
      track.languageReview = languageReviewFor(explicit.languageReview);
    }
    if (explicit.decision === "rejected") track.rejectionReason = explicit.reason;
    else delete track.rejectionReason;
  }
}
}

const baselineRoot = JSON.parse(readFileSync(baselineFile, "utf8"));
applyDecisionRoot(tracks, baselineRoot);
for (const finalizedFile of finalizedPassFiles) {
  applyDecisionRoot(tracks, JSON.parse(readFileSync(finalizedFile, "utf8")), true);
}
const baselineExcluded = tracks.filter((track) => track.reviewStatus === "rejected");
const retainedTracks = tracks.filter((track) => track.reviewStatus !== "rejected");
const keepsRoot = JSON.parse(readFileSync(keepsFile, "utf8"));
if (!Array.isArray(keepsRoot.tracks)) throw new Error("Reviewed keeps file needs a tracks array.");
for (const keep of keepsRoot.tracks) {
  const matches = retainedTracks.filter((track) => (
    normalizedDecisionTitle(track.title) === normalizedDecisionTitle(keep.title)
    && likelySameArtist(track.artist, keep.artist)
  ));
  if (matches.length !== 1) {
    throw new Error(`Reviewed keep must match exactly one retained track: ${keep.title} — ${keep.artist} (found ${matches.length}).`);
  }
  const [track] = matches;
  if (!track.signals.includes("reviewed_keep")) track.signals.push("reviewed_keep");
  track.reviewStatus = "shortlisted";
  track.keepReason = keep.reason ?? "broad_recognition";
}
const decisionRoot = JSON.parse(readFileSync(decisionsFile, "utf8"));
applyDecisionRoot(retainedTracks, decisionRoot, true);
const activeTracks = retainedTracks.filter((track) => track.reviewStatus !== "rejected");

const generatedAt = new Date().toISOString();
const snapshot = {
  version: 1,
  status: "intake_longlist",
  generatedAt,
  notes: "Active intake songs only. Pruning rules are applied during generation so rejected tracks do not remain visible in this file. The billion-stream source does not publish song language, so source-only rows remain languageReview=pending until a human checks them.",
  sources: [
    { label: "Spotify BILLIONS CLUB", url: officialPlaylistUrl },
    { label: "TooXclusive billion-stream tracker", url: sourceUrl },
    { label: "Founder and Gen-Z additions", file: "data/song-manual-additions.json" },
    founderPlaylistSource,
    { label: "Finalized exclusions", file: "data/song-longlist-baseline.json" },
    { label: "Finalized recognition pass 4", file: "data/song-longlist-finalized-pass-4.json" },
    { label: "Reviewed keeps", file: "data/song-longlist-keeps.json" },
    { label: "Current pruning decisions", file: "data/song-longlist-decisions.json" },
  ],
  counts: {
    billionSnapshot: billionTracks.length,
    billionIncluded: activeTracks.filter((track) => track.signals.includes("billion_streams")).length,
    founderPicks: activeTracks.filter((track) => track.signals.includes("founder_pick")).length,
    personalPlaylist: activeTracks.filter((track) => track.signals.includes("personal_playlist")).length,
    reviewedKeeps: activeTracks.filter((track) => track.signals.includes("reviewed_keep")).length,
    playlistSourceTracks: founderPlaylistTracks.length,
    finalizedExclusions: baselineExcluded.length,
    excludedByCurrentDecisions: retainedTracks.length - activeTracks.length,
    active: activeTracks.length,
    combinedUnique: activeTracks.length,
  },
  tracks: activeTracks,
};

const activeLines = activeTracks
  .map((track) => `${track.title} — ${track.artist}${track.signals.includes("billion_streams") ? ` (${track.displayedStreams})` : ""}`);
const text = [
  "SONGLESS ACTIVE SONG LONGLIST",
  `Generated: ${generatedAt}`,
  "",
  `SONGS (${activeLines.length})`,
  ...activeLines,
  "",
].join("\n");

writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
writeFileSync(textFile, text, "utf8");
console.log(`Wrote ${snapshot.counts.active} active intake records; ${snapshot.counts.excludedByCurrentDecisions} current prunes and ${snapshot.counts.finalizedExclusions} finalized exclusions were omitted.`);
