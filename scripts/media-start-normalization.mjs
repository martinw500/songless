// Game-time zero must land on audible music, not on the noise floor that
// precedes it. Thresholds are relative to each song's own body loudness,
// because a fixed dBFS floor cannot separate a quiet analogue intro from
// digital silence across a catalogue this varied.
//
// The shortest normal clue is 100 ms, so that window is the unit of judgement.
// It is split into five 20 ms sub-windows: a clue sounds continuous when its
// sub-windows are audible, and sounds empty when only its tail carries energy.

export const clueWindowMs = 100;
export const subWindowMs = 20;
export const subWindowCount = clueWindowMs / subWindowMs;
export const leadSilenceMs = 30;
export const mp3FrameToleranceMs = 26;
export const digitalSilenceDb = -90;

// One quiet sub-window is a note attack, which is how music actually starts.
export const gateOffsetDb = -26;
export const gateMinAudibleSubWindows = 4;

// The corrected start is held to the stricter of the two so that a start we
// choose sits comfortably inside the gate rather than on its boundary. That
// margin also absorbs an MP3 seek that lands one frame early.
export const onsetOffsetDb = -20;

// A deliberately soft intro is still the song. When the strict threshold is
// only reached long after the clue first sounds continuous, the song opens
// quietly on purpose and the gate boundary is the honest start.
export const onsetPreferenceWindowMs = 250;

export const clueWindowPass = "pass";
export const clueWindowSilent = "clue-window-silent";

export function configuredStartMs(song) {
  return song.startAtMs ?? song.media?.onsetPadMs ?? 30;
}

// clueGainDb is the clue-only boost the player hears, so it belongs on the
// measured side of every comparison rather than on the threshold.
export function audibleSubWindowCount(subWindowDbs, bodyDb, clueGainDb, offsetDb) {
  const threshold = bodyDb + offsetDb;
  return subWindowDbs.filter((db) => Number.isFinite(db) && db + clueGainDb >= threshold).length;
}

export function clueWindowIsAudible(subWindowDbs, bodyDb, clueGainDb = 0, offsetDb = onsetOffsetDb, required = subWindowCount) {
  if (!Number.isFinite(bodyDb) || subWindowDbs.length < subWindowCount) return false;
  return audibleSubWindowCount(subWindowDbs, bodyDb, clueGainDb, offsetDb) >= required;
}

export function evaluateClueWindow({
  bodyDb,
  clueGainDb = 0,
  subWindowDbs = [],
  leadHasDigitalSilence = false,
}) {
  const reasons = [];
  if (!Number.isFinite(bodyDb) || subWindowDbs.length < subWindowCount) {
    return { status: clueWindowPass, reasons, audibleSubWindows: null };
  }
  const audible = audibleSubWindowCount(subWindowDbs, bodyDb, clueGainDb, gateOffsetDb);
  if (leadHasDigitalSilence) reasons.push("digital-silence-lead-in");
  if (audible < gateMinAudibleSubWindows) reasons.push("clue-mostly-inaudible");
  return {
    status: reasons.length > 0 ? clueWindowSilent : clueWindowPass,
    reasons,
    audibleSubWindows: audible,
  };
}

// A failing clue window is an audible defect, so it corrects documented
// overrides too. Overrides remain authoritative for clueGainDb and for every
// song whose measured clue window already passes.
//
// Corrections only ever move forward. A measured onset that sits before the
// configured start means the start was chosen deliberately, to open on a hook
// or to skip an intro, and unwinding that is a human decision.
export function automaticStartMs(song, feature, _hasDocumentedOverride) {
  if (feature?.clueWindowStatus !== clueWindowSilent) return null;
  const onsetMs = feature.musicOnsetMs;
  if (!Number.isInteger(onsetMs) || onsetMs < 0) return null;
  return onsetMs > configuredStartMs(song) ? onsetMs : null;
}
