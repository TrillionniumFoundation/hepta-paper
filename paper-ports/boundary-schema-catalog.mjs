const HASH = /^sha256:[a-f0-9]{64}$/i;

const schema = (version, required = [], hashes = []) => Object.freeze({ version, required: Object.freeze(required), hashes: Object.freeze(hashes) });

export const BOUNDARY_SCHEMA_CATALOG = Object.freeze({
  ExternalExecutorHandoffOutbox: schema(1, ['paperId', 'action', 'manifestHash', 'replayGuardHash'], ['manifestHash', 'replayGuardHash']),
  ExecutorResponseIntake: schema(1, ['paperId', 'dispatchAuthorizationHash', 'responseId', 'outcome'], ['dispatchAuthorizationHash', 'executorResponseVerificationReceiptHash']),
  LiveSubmissionAuthorizationSubject: schema(1, ['paperId', 'action', 'artifactPackageHash', 'provider', 'accountId', 'portalRoute', 'providerCapabilityVerificationReceiptHash', 'executorDescriptorHash', 'reviewedSubmissionDecisionPacketHash', 'reviewedVenueEvidenceHash', 'venueObservationSourceVerificationReceiptHash', 'venueObservationSubjectHash', 'venueObserverId', 'venueObservationPurpose'], ['artifactPackageHash', 'providerCapabilityVerificationReceiptHash', 'executorDescriptorHash', 'reviewedSubmissionDecisionPacketHash', 'reviewedVenueEvidenceHash', 'venueObservationSourceVerificationReceiptHash', 'venueObservationSubjectHash', 'redrivePlanHash', 'redriveDecisionHash', 'priorDispatchAuthorizationHash', 'priorDispatchCycleHash']),
  ProviderSubmissionReceipt: schema(1, ['provider', 'accountId', 'submissionId', 'dispatchAuthorizationHash'], ['dispatchAuthorizationHash']),
  ReviewedVenueEvidence: schema(1, ['paperId', 'purpose', 'portalRoute', 'venueTarget', 'track', 'observedAt', 'expiresAt', 'reviewedBy', 'evidenceHashes', 'observationSubjectHash', 'sourceVerificationReceiptHash'], ['venueSubmissionPlanHash', 'observationSubjectHash', 'sourceVerificationReceiptHash']),
  SubmissionExecutorDescriptor: schema(1, ['executorId', 'provider', 'accountId', 'capabilitiesHash'], ['capabilitiesHash']),
  ExecutorResponseVerificationReceipt: schema(1, ['responseId', 'dispatchAuthorizationHash', 'executorId', 'executorDescriptorHash', 'capabilitiesHash'], ['dispatchAuthorizationHash', 'executorDescriptorHash', 'capabilitiesHash']),
  ReviewedSubmissionDecisionPacket: schema(1, ['paperId', 'metadata', 'reviewedBy', 'reviewedAt', 'humanConfirmedFields'], ['venueSubmissionPlanHash']),
  SubmissionIntakeQuarantineReceipt: schema(1, ['quarantineId', 'payloadHash', 'failureCodes', 'receivedAt'], ['payloadHash']),
  ProviderCapabilityVerificationReceipt: schema(1, ['provider', 'accountId', 'portalRoute', 'executorDescriptorHash', 'capabilitiesHash', 'attestationHash', 'expiresAt'], ['executorDescriptorHash', 'capabilitiesHash', 'attestationHash']),
  SubmissionDeliveryLeaseReceipt: schema(1, ['messageId', 'provider', 'accountId', 'workerId', 'leaseTokenHash', 'leaseExpiresAt'], ['dispatchAuthorizationHash', 'leaseTokenHash', 'providerCapabilityVerificationReceiptHash']),
});

export function validateBoundaryRecord(record) {
  const selected = BOUNDARY_SCHEMA_CATALOG[record?.kind] || null;
  const blockers = [];
  if (!selected) blockers.push(`boundary_schema_unknown:${record?.kind || 'missing'}`);
  else {
    if (record.version !== selected.version) blockers.push(`boundary_schema_version_invalid:${record.kind}`);
    for (const field of selected.required) {
      const value = record[field];
      if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) blockers.push(`boundary_field_missing:${record.kind}:${field}`);
    }
    for (const field of selected.hashes) if (record[field] && !HASH.test(String(record[field]))) blockers.push(`boundary_hash_invalid:${record.kind}:${field}`);
  }
  return Object.freeze({ version: 1, kind: 'BoundarySchemaValidation', recordKind: record?.kind || null, status: blockers.length ? 'boundary_schema_blocked' : 'boundary_schema_verified', blockers });
}

export function assertBoundaryRecord(record) {
  const report = validateBoundaryRecord(record);
  if (report.status !== 'boundary_schema_verified') throw new Error(report.blockers.join(','));
  return record;
}
