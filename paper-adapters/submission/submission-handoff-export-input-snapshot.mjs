function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function snapshotSubmissionHandoffExportInput(input = {}) {
  const serializableInput = { ...input };
  delete serializableInput.artifactRepository;
  delete serializableInput.submissionAuthorityFreshnessQuery;
  const encoded = JSON.stringify(serializableInput);
  if (typeof encoded !== 'string') {
    throw new Error('handoff_export_input_snapshot_invalid');
  }
  return deepFreeze(JSON.parse(encoded));
}
