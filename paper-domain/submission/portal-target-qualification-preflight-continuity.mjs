function finding(errorCode, targetVenueId = null) {
  return Object.freeze({ errorCode, targetVenueId });
}

function entries(registry) {
  return Array.isArray(registry?.entries) ? registry.entries : [];
}

export function inspectPortalTargetQualificationPreflightContinuity({
  currentRegistry = null,
  candidateRegistry = null,
} = {}) {
  if (!candidateRegistry) return Object.freeze([]);
  const findings = [];
  if (!currentRegistry) {
    if (candidateRegistry.generation !== 1) {
      findings.push(finding(
        'portal_target_qualification_preflight_generation_drift',
      ));
    }
    if (candidateRegistry.predecessorRegistryHash !== null) {
      findings.push(finding(
        'portal_target_qualification_preflight_predecessor_drift',
      ));
    }
    if (candidateRegistry.revokedQualificationHashes.length > 0) {
      findings.push(finding(
        'portal_target_qualification_preflight_revocation_drift',
      ));
    }
    return Object.freeze(findings);
  }

  if (candidateRegistry.generation !== currentRegistry.generation + 1
    || Date.parse(candidateRegistry.issuedAt) <= Date.parse(currentRegistry.issuedAt)) {
    findings.push(finding(
      'portal_target_qualification_preflight_generation_drift',
    ));
  }
  if (candidateRegistry.predecessorRegistryHash
    !== currentRegistry.portalTargetQualificationRegistryHash) {
    findings.push(finding(
      'portal_target_qualification_preflight_predecessor_drift',
    ));
  }

  const currentHashes = new Set(entries(currentRegistry).map(
    (entry) => entry.portalTargetQualificationHash,
  ));
  const revoked = new Set(candidateRegistry.revokedQualificationHashes);
  if ([...revoked].some((hash) => !currentHashes.has(hash))) {
    findings.push(finding(
      'portal_target_qualification_preflight_revocation_drift',
    ));
  }
  const candidateEntries = new Map(entries(candidateRegistry).map(
    (entry) => [entry.venueId, entry],
  ));
  for (const prior of entries(currentRegistry)) {
    const next = candidateEntries.get(prior.venueId) || null;
    const changed = !next
      || next.portalTargetQualificationHash !== prior.portalTargetQualificationHash;
    const priorRevoked = revoked.has(prior.portalTargetQualificationHash);
    if (changed !== priorRevoked) {
      findings.push(finding(
        'portal_target_qualification_preflight_revocation_drift',
        prior.venueId,
      ));
    }
    // A signed revocation authorizes replacement of the qualification record;
    // it does not authorize silently rebinding the portal subject, route, or
    // schema.  Compare those stable bindings on the normal changed+revoked
    // successor path as well.
    if (!next || !changed) continue;
    if (next.portalTargetSubjectHash !== prior.portalTargetSubjectHash) {
      findings.push(finding(
        'portal_target_qualification_preflight_subject_mismatch',
        prior.venueId,
      ));
    }
    if (next.submissionRouteHash !== prior.submissionRouteHash) {
      findings.push(finding(
        'portal_target_qualification_preflight_route_mismatch',
        prior.venueId,
      ));
    }
    if (next.schemaFingerprintHash !== prior.schemaFingerprintHash) {
      findings.push(finding(
        'portal_target_qualification_preflight_schema_mismatch',
        prior.venueId,
      ));
    }
  }
  if (entries(candidateRegistry).some(
    (entry) => revoked.has(entry.portalTargetQualificationHash),
  )) {
    findings.push(finding(
      'portal_target_qualification_preflight_revocation_drift',
    ));
  }
  return Object.freeze(findings);
}
