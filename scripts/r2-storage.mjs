export function projectedBucketBytes(existingObjects, assets) {
  const existingBytes = [...existingObjects.values()].reduce((total, size) => total + size, 0);
  const projectedBytes = assets.reduce(
    (total, asset) => total + asset.size - (existingObjects.get(asset.key) ?? 0),
    existingBytes,
  );
  return { existingBytes, projectedBytes };
}

export function assertWithinR2Budget(projectedBytes, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 9_000_000_000) {
    throw new Error("R2_MAX_BYTES must be a positive integer no greater than 9000000000.");
  }
  if (projectedBytes > maxBytes) {
    throw new Error("Upload refused before writing: the projected bucket size exceeds R2_MAX_BYTES.");
  }
}
