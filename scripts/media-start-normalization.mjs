export const shortClueDeadZoneMs = 100;

export function configuredStartMs(song) {
  return song.startAtMs ?? song.media?.onsetPadMs ?? 30;
}

export function automaticStartMs(song, feature, hasDocumentedOverride) {
  if (hasDocumentedOverride || !Number.isFinite(feature?.firstAudibleMs)) return null;
  const currentStartMs = configuredStartMs(song);
  return feature.firstAudibleMs - currentStartMs >= shortClueDeadZoneMs
    ? feature.firstAudibleMs
    : null;
}
