import { JOURNAL_PROFILES } from '../journal/journal-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildJournalSubmissionTargetRegistry,
} from './journal-submission-target-registry.mjs';
import {
  SUBMISSION_CONNECTOR_FAMILY_REGISTRY,
} from './submission-connector-family-registry.mjs';

function coverageEntry(target) {
  const payload = {
    version: 2,
    kind: 'JournalSubmissionConnectorCoverageEntry',
    venueId: target.venueId,
    venueLabel: target.venueLabel,
    venueKind: target.venueKind,
    journalSubmissionTargetProfileHash:
      target.journalSubmissionTargetProfileHash,
    discoveryLane: target.discoveryLane,
    connectorFamily: target.selectedConnectorFamily,
    candidateConnectorFamilies: target.candidateConnectorFamilies,
    connectorDisposition: target.prototypeAdapterPresent
      ? 'prototype_adapter_present_target_binding_unverified'
      : target.identityStatus === 'composite-identity-blocked'
        ? 'venue_identity_split_required'
        : target.connectorFamilyPrototypeAvailable
          ? 'connector_family_prototype_present_target_profile_required'
          : 'platform_binding_and_connector_required',
    identityKnown: target.identityStatus === 'stable-venue-identity-known',
    targetProfileResolved: target.portalBindingStatus === 'verified',
    connectorFamilyPrototypeAvailable:
      target.connectorFamilyPrototypeAvailable,
    prototypeAdapterPresent: target.prototypeAdapterPresent,
    adapterImplemented: target.adapterImplemented,
    implementationReady: target.adapterImplemented,
    sandboxQualified: target.sandboxQualified,
    productionQualified: target.productionQualified,
    liveCommitAuthorized: target.liveCommitAuthorized,
    liveSubmissionReady: target.liveSubmissionReady,
    discoveryRequired: target.discoveryRequired,
    finalCommitRequiresHumanReview: target.finalCommitRequiresHumanReview,
    blindCommitRetryPermitted: target.blindCommitRetryPermitted,
    blockers: target.blockers,
  };
  return Object.freeze({
    ...payload,
    journalSubmissionConnectorCoverageEntryHash:
      hashRecord('JournalSubmissionConnectorCoverageEntry', payload),
  });
}

export function buildJournalConnectorCoverage({
  profiles = JOURNAL_PROFILES,
} = {}) {
  const targetRegistry = buildJournalSubmissionTargetRegistry({ profiles });
  const entries = Object.freeze(targetRegistry.targets.map(coverageEntry)
    .sort((left, right) => left.venueId.localeCompare(right.venueId)));
  if (new Set(entries.map((entry) => entry.venueId)).size !== profiles.length) {
    throw new Error('journal_submission_connector_coverage_duplicate_venue');
  }
  const payload = {
    version: 2,
    kind: 'JournalSubmissionConnectorCoverage',
    status: entries.every((entry) => entry.liveSubmissionReady)
      ? 'journal_submission_connectors_live_ready'
      : 'journal_submission_connectors_incomplete',
    journalProfileCount: profiles.length,
    dispositionCount: entries.length,
    connectorFamilyRegistryHash:
      SUBMISSION_CONNECTOR_FAMILY_REGISTRY.submissionConnectorFamilyRegistryHash,
    targetRegistryHash:
      targetRegistry.journalSubmissionTargetRegistryHash,
    identityKnownCount: entries.filter((entry) => entry.identityKnown).length,
    targetProfileResolvedCount:
      entries.filter((entry) => entry.targetProfileResolved).length,
    connectorFamilyPrototypeAvailableCount:
      entries.filter((entry) => (
        entry.connectorFamilyPrototypeAvailable
      )).length,
    journalConnectorFamilyPrototypeAvailableCount:
      entries.filter((entry) => (
        entry.venueKind === 'journal'
          && entry.connectorFamilyPrototypeAvailable
      )).length,
    prototypeAdapterPresentCount:
      entries.filter((entry) => entry.prototypeAdapterPresent).length,
    adapterImplementedCount:
      entries.filter((entry) => entry.adapterImplemented).length,
    implementationReadyCount:
      entries.filter((entry) => entry.implementationReady).length,
    sandboxQualifiedCount:
      entries.filter((entry) => entry.sandboxQualified).length,
    productionQualifiedCount:
      entries.filter((entry) => entry.productionQualified).length,
    liveCommitAuthorizedCount:
      entries.filter((entry) => entry.liveCommitAuthorized).length,
    liveSubmissionReadyCount:
      entries.filter((entry) => entry.liveSubmissionReady).length,
    discoveryRequiredCount:
      entries.filter((entry) => entry.discoveryRequired).length,
    silentFallbackPermitted: false,
    entries,
  };
  return Object.freeze({
    ...payload,
    journalSubmissionConnectorCoverageHash:
      hashRecord('JournalSubmissionConnectorCoverage', payload),
  });
}

export const JOURNAL_SUBMISSION_CONNECTOR_COVERAGE =
  buildJournalConnectorCoverage();
