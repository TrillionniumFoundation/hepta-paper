import { JOURNAL_PROFILES } from '../journal/journal-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SUBMISSION_CONNECTOR_FAMILY_REGISTRY,
} from './submission-connector-family-registry.mjs';

const ROUTING_GROUPS = Object.freeze([
  Object.freeze({
    discoveryLane: 'openreview-current-prototype',
    venueIds: Object.freeze(['iclr', 'icml', 'neurips', 'tmlr']),
    candidateConnectorFamilies: Object.freeze(['openreview-api-v2']),
    selectedConnectorFamily: 'openreview-api-v2',
    prototypeAdapterPresent: true,
  }),
  Object.freeze({
    discoveryLane: 'conference-openreview-candidate',
    venueIds: Object.freeze([
      'acl', 'cvpr', 'eccv', 'emnlp', 'iccv', 'kdd', 'naacl', 'rss', 'sigmod', 'www',
    ]),
    candidateConnectorFamilies: Object.freeze([
      'openreview-api-v2', 'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'conference-hotcrp-candidate',
    venueIds: Object.freeze([
      'asplos', 'ccs', 'focs', 'fse', 'ieee_sp', 'isca', 'micro', 'ndss', 'nsdi',
      'osdi', 'pldi', 'popl', 'sigcomm', 'soda', 'sosp', 'stoc', 'usenix_security',
    ]),
    candidateConnectorFamilies: Object.freeze([
      'hotcrp-rest-v1', 'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'conference-cmt-candidate',
    venueIds: Object.freeze(['icse', 'vldb']),
    candidateConnectorFamilies: Object.freeze([
      'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'conference-pcs-candidate',
    venueIds: Object.freeze(['chi', 'uist']),
    candidateConnectorFamilies: Object.freeze([
      'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'conference-linklings-candidate',
    venueIds: Object.freeze(['siggraph']),
    candidateConnectorFamilies: Object.freeze([
      'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'conference-papercept-candidate',
    venueIds: Object.freeze(['icra']),
    candidateConnectorFamilies: Object.freeze([
      'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'composite-venue-identity-requires-split',
    venueIds: Object.freeze(['colt_alt']),
    candidateConnectorFamilies: Object.freeze(['manual-handoff-v1']),
    identityStatus: 'composite-identity-blocked',
  }),
  Object.freeze({
    discoveryLane: 'journal-scholarone-organization-candidate',
    venueIds: Object.freeze([
      'informs_joc', 'isr', 'jacm', 'management_science', 'marketing_science',
      'moor', 'msom', 'operations_research', 'organization_science', 'sicomp',
      'siam_optimization', 'taco', 'tdsc', 'tochi', 'tocs', 'toga', 'tois',
      'toplas', 'tpami', 'tro', 'tse', 'ieee_tac',
    ]),
    candidateConnectorFamilies: Object.freeze([
      'scholarone-submission-integration-v1',
      'playwright-assisted-draft-v1',
      'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'journal-oup-scholarone-candidate',
    venueIds: Object.freeze(['biometrika', 'jcr', 'jrssb', 'qje', 'restud', 'rfs']),
    candidateConnectorFamilies: Object.freeze([
      'scholarone-submission-integration-v1',
      'playwright-assisted-draft-v1',
      'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'journal-scholarone-candidate',
    venueIds: Object.freeze([
      'amj', 'amr', 'asq', 'ijrr', 'jasa', 'jmr', 'journal_marketing', 'misq',
    ]),
    candidateConnectorFamilies: Object.freeze([
      'scholarone-submission-integration-v1',
      'playwright-assisted-draft-v1',
      'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'journal-editorial-manager-candidate',
    venueIds: Object.freeze(['automatica', 'jae', 'jfe']),
    candidateConnectorFamilies: Object.freeze([
      'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'journal-independent-platform-discovery',
    venueIds: Object.freeze([
      'aer', 'annals_math', 'aos', 'econometrica', 'jmlr', 'nature',
      'nature_machine_intelligence', 'science',
    ]),
    candidateConnectorFamilies: Object.freeze([
      'ojs-rest-v1', 'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
  Object.freeze({
    discoveryLane: 'journal-platform-migration-discovery',
    venueIds: Object.freeze([
      'accounting_review', 'acta_math', 'inventiones', 'jams', 'jar', 'jibs',
      'jom', 'journal_finance', 'jpe', 'pom', 'smj', 'tacl',
    ]),
    candidateConnectorFamilies: Object.freeze([
      'scholarone-submission-integration-v1', 'ojs-rest-v1',
      'playwright-assisted-draft-v1', 'manual-handoff-v1',
    ]),
  }),
]);

function buildRoutingIndex() {
  const index = new Map();
  for (const group of ROUTING_GROUPS) {
    for (const venueId of group.venueIds) {
      if (index.has(venueId)) {
        throw new Error(`journal_submission_target_routing_duplicate:${venueId}`);
      }
      index.set(venueId, group);
    }
  }
  return index;
}

const ROUTING_INDEX = buildRoutingIndex();
const CONNECTOR_FAMILIES = new Set(
  SUBMISSION_CONNECTOR_FAMILY_REGISTRY.families
    .map((family) => family.connectorFamily),
);
const PROTOTYPE_CONNECTOR_FAMILIES = new Set(
  SUBMISSION_CONNECTOR_FAMILY_REGISTRY.families
    .filter((family) => (
      family.implementationStatus === 'prototype-adapter-present'
    ))
    .map((family) => family.connectorFamily),
);

function targetEntry(profile) {
  if (!profile?.id || !profile?.label || !['conference', 'journal'].includes(profile?.kind)) {
    throw new Error('journal_submission_target_profile_invalid');
  }
  const routing = ROUTING_INDEX.get(profile.id);
  if (!routing) {
    throw new Error(`journal_submission_target_routing_missing:${profile.id}`);
  }
  const candidateConnectorFamilies = Object.freeze(
    [...routing.candidateConnectorFamilies],
  );
  if (candidateConnectorFamilies.some((family) => !CONNECTOR_FAMILIES.has(family))) {
    throw new Error(`journal_submission_target_connector_family_unknown:${profile.id}`);
  }
  const selectedConnectorFamily = routing.selectedConnectorFamily
    || 'portal-schema-discovery-required-v1';
  const prototypeAdapterPresent = routing.prototypeAdapterPresent === true;
  const connectorFamilyPrototypeAvailable =
    candidateConnectorFamilies.some((family) => (
      PROTOTYPE_CONNECTOR_FAMILIES.has(family)
    ));
  const identityStatus = routing.identityStatus || 'stable-venue-identity-known';
  const blockers = [
    ...(identityStatus === 'composite-identity-blocked'
      ? ['venue_identity_split_required'] : []),
    ...(profile.kind === 'conference'
      ? ['venue_edition_cycle_and_track_binding_required'] : []),
    'submission_portal_binding_evidence_required',
    'submission_terms_and_automation_policy_evidence_required',
    'submission_schema_snapshot_required',
    'submission_authentication_profile_required',
    ...(!connectorFamilyPrototypeAvailable
      ? ['submission_connector_implementation_required']
      : !prototypeAdapterPresent
        ? ['submission_target_adapter_profile_required']
        : []),
    'independent_connector_execution_attestation_required',
    'submission_live_no_side_effect_canary_required',
    'final_commit_human_review_and_single_use_permit_required',
  ];
  const payload = {
    version: 1,
    kind: 'JournalSubmissionTargetProfile',
    venueId: profile.id,
    venueLabel: profile.label,
    venueKind: profile.kind,
    journalProfileHash: hashRecord('JournalProfileSnapshot', profile),
    identityStatus,
    targetInstanceStatus: profile.kind === 'conference'
      ? 'edition-cycle-track-unbound'
      : 'journal-instance-unbound',
    discoveryLane: routing.discoveryLane,
    candidateConnectorFamilies,
    selectedConnectorFamily,
    portalBindingStatus: 'unverified',
    schemaStatus: 'unverified',
    automationPolicyStatus: 'unverified',
    authenticationProfileStatus: 'unverified',
    connectorFamilyPrototypeAvailable,
    prototypeAdapterPresent,
    adapterImplemented: prototypeAdapterPresent,
    sandboxQualified: false,
    productionQualified: false,
    liveCommitAuthorized: false,
    liveSubmissionReady: false,
    finalCommitRequiresHumanReview: true,
    unknownDeclarationsBlockCommit: true,
    blindCommitRetryPermitted: false,
    discoveryRequired: true,
    blockers: Object.freeze(blockers),
  };
  return Object.freeze({
    ...payload,
    journalSubmissionTargetProfileHash:
      hashRecord('JournalSubmissionTargetProfile', payload),
  });
}

export function buildJournalSubmissionTargetRegistry({
  profiles = JOURNAL_PROFILES,
} = {}) {
  if (!Array.isArray(profiles) || !profiles.length) {
    throw new Error('journal_submission_target_profiles_required');
  }
  const profileIds = profiles.map((profile) => profile?.id);
  if (profileIds.some((venueId) => !venueId)
    || new Set(profileIds).size !== profileIds.length) {
    throw new Error('journal_submission_target_profile_identity_invalid');
  }
  const unexpectedRoutes = [...ROUTING_INDEX.keys()]
    .filter((venueId) => !profileIds.includes(venueId));
  if (unexpectedRoutes.length) {
    throw new Error(
      `journal_submission_target_routing_orphan:${unexpectedRoutes.sort().join(',')}`,
    );
  }
  const targets = Object.freeze(profiles.map(targetEntry)
    .sort((left, right) => left.venueId.localeCompare(right.venueId)));
  const payload = {
    version: 1,
    kind: 'JournalSubmissionTargetRegistry',
    status: targets.every((target) => target.liveSubmissionReady)
      ? 'journal_submission_targets_live_ready'
      : 'journal_submission_targets_discovery_required',
    journalProfileCount: profiles.length,
    targetProfileCount: targets.length,
    conferenceTargetCount:
      targets.filter((target) => target.venueKind === 'conference').length,
    journalTargetCount:
      targets.filter((target) => target.venueKind === 'journal').length,
    connectorFamilyPrototypeAvailableCount:
      targets.filter((target) => (
        target.connectorFamilyPrototypeAvailable
      )).length,
    conferenceConnectorFamilyPrototypeAvailableCount:
      targets.filter((target) => (
        target.venueKind === 'conference'
          && target.connectorFamilyPrototypeAvailable
      )).length,
    journalConnectorFamilyPrototypeAvailableCount:
      targets.filter((target) => (
        target.venueKind === 'journal'
          && target.connectorFamilyPrototypeAvailable
      )).length,
    prototypeAdapterPresentCount:
      targets.filter((target) => target.prototypeAdapterPresent).length,
    sandboxQualifiedCount:
      targets.filter((target) => target.sandboxQualified).length,
    productionQualifiedCount:
      targets.filter((target) => target.productionQualified).length,
    liveCommitAuthorizedCount:
      targets.filter((target) => target.liveCommitAuthorized).length,
    liveSubmissionReadyCount:
      targets.filter((target) => target.liveSubmissionReady).length,
    discoveryRequiredCount:
      targets.filter((target) => target.discoveryRequired).length,
    silentFallbackPermitted: false,
    targets,
  };
  return Object.freeze({
    ...payload,
    journalSubmissionTargetRegistryHash:
      hashRecord('JournalSubmissionTargetRegistry', payload),
  });
}

export const JOURNAL_SUBMISSION_TARGET_REGISTRY =
  buildJournalSubmissionTargetRegistry();

export function getJournalSubmissionTargetProfile(venueId, {
  registry = JOURNAL_SUBMISSION_TARGET_REGISTRY,
} = {}) {
  const selected = registry.targets.find((target) => target.venueId === venueId);
  if (!selected) throw new Error(`journal_submission_target_unknown:${venueId}`);
  return selected;
}
