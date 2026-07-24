import crypto from 'node:crypto';

import {
  autonomousResearchOnlineMutationReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  createAutonomousResearchOnlineMutationAuthorityProcessClient,
} from './autonomous-research-online-mutation-authority.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from './autonomous-research-online-writer-operation-manifest.mjs';
import {
  inspectAutonomousResearchOnlineWriterStaticCoverage,
} from './autonomous-research-online-writer-static-inspection.mjs';
import {
  observedExternallyFencedSqliteMutationNow,
} from './externally-fenced-sqlite-storage-primitives.mjs';

function fail(code) { throw new Error(code); }

const observedNow = (clock) => observedExternallyFencedSqliteMutationNow(
  clock,
  'autonomous_research_online_mutation_active_refresh_clock_invalid',
);

function expectedDatabaseInstances(inventory) {
  if (inventory?.status !== 'autonomous_research_state_database_inventory_ready'
    || !Array.isArray(inventory.instances)) {
    fail('autonomous_research_online_mutation_active_refresh_inventory_required');
  }
  const roles = [...new Set(inventory.instances.map((entry) => entry.role))].sort();
  if (roles.join('\0') !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')) {
    fail('autonomous_research_online_mutation_active_refresh_inventory_incomplete');
  }
  return Object.freeze(inventory.instances.map((instance) => Object.freeze({
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    schemaHash: instance.schemaHash,
  })).sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId)));
}

function requestBase(trust, requestedAt) {
  return {
    version: 1,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: trust.scopeId,
    databaseScopeHash: trust.databaseScopeHash,
    writerManifestHash: trust.writerManifestHash,
    requestedAt,
  };
}

function requests({ trust, staticInspection, manifest, requestedAt }) {
  const base = requestBase(trust, requestedAt);
  return Object.freeze({
    current: Object.freeze({
      ...base,
      kind: 'AutonomousResearchOnlineMutationCurrentHeadRequest',
      nonce: `head:${crypto.randomUUID()}`,
    }),
    challenge: Object.freeze({
      ...base,
      kind: 'AutonomousResearchOnlineMutationActiveChallengeRequest',
      challengeNonce: `challenge:${crypto.randomUUID()}`,
    }),
    scope: Object.freeze({
      ...base,
      kind: 'AutonomousResearchOnlineMutationScopeRequest',
      staticInspectionReceiptHash: staticInspection.astGateReceiptHash,
      astGateReceiptHash: staticInspection.astGateReceiptHash,
      codeProvenanceHash: staticInspection.codeProvenanceHash,
      operationCount: staticInspection.operationCount,
      operationIds: Object.freeze([...staticInspection.operationIds]),
      requiredDatabaseRoles: Object.freeze([...manifest.requiredDatabaseRoles]),
      coveredDatabaseRoles: Object.freeze([...manifest.coverage.coveredDatabaseRoles]),
      nonce: `scope:${crypto.randomUUID()}`,
    }),
  });
}

function sameDatabaseHeads(left, right) {
  return JSON.stringify(left?.databaseHeads || []) === JSON.stringify(right?.databaseHeads || []);
}

function sameLinearizedHead(current, challenge, scope) {
  return current?.globalSequence === challenge?.globalSequence
    && current.globalSequence === scope?.globalSequence
    && current?.globalHash === challenge?.globalHash
    && current.globalHash === scope?.globalHash
    && sameDatabaseHeads(current, challenge);
}

function journalEntries(requestSet, receipts) {
  return Object.freeze({
    'current-head': Object.freeze({
      role: 'current-head', request: requestSet.current, receipt: receipts.current,
    }),
    'active-challenge': Object.freeze({
      role: 'active-challenge', request: requestSet.challenge, receipt: receipts.challenge,
    }),
    'broker-scope': Object.freeze({
      role: 'broker-scope', request: requestSet.scope, receipt: receipts.scope,
    }),
  });
}

export function refreshAutonomousResearchOnlineMutationAuthorityEvidence({
  workspaceRoot,
  runtimeRoot,
  inventory,
  authorityProcessConfigurationPath,
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  clock = { now: () => new Date() },
  maximumLinearizationAttempts = 3,
  createAuthorityClient = createAutonomousResearchOnlineMutationAuthorityProcessClient,
  inspectStaticCoverage = inspectAutonomousResearchOnlineWriterStaticCoverage,
  recordJournalEvidence = false,
} = {}) {
  if (!workspaceRoot || !runtimeRoot || !authorityProcessConfigurationPath
    || recordJournalEvidence !== false
    || !Number.isSafeInteger(maximumLinearizationAttempts)
    || maximumLinearizationAttempts < 1 || maximumLinearizationAttempts > 5) {
    fail('autonomous_research_online_mutation_active_refresh_configuration_invalid');
  }
  const expectedInstances = expectedDatabaseInstances(inventory);
  const staticInspection = inspectStaticCoverage({ workspaceRoot, manifest });
  if (staticInspection?.status
      !== 'autonomous_research_online_writer_static_coverage_complete'
    || staticInspection.blockers?.length !== 0) {
    fail('autonomous_research_online_mutation_active_refresh_static_coverage_required');
  }
  const authorityClient = createAuthorityClient({
    processConfigurationPath: authorityProcessConfigurationPath,
  });
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(manifest);
  if (authorityClient?.trust?.writerManifestHash !== manifestHash
    || authorityClient.trust.databaseScopeHash !== inventory.databaseScopeHash
    || typeof authorityClient.observeCurrentHead !== 'function'
    || typeof authorityClient.challengeActiveAuthority !== 'function'
    || typeof authorityClient.observeScope !== 'function') {
    fail('autonomous_research_online_mutation_active_refresh_authority_mismatch');
  }
  let selected = null;
  for (let attempt = 1; attempt <= maximumLinearizationAttempts; attempt += 1) {
    const requestSet = requests({
      trust: authorityClient.trust,
      staticInspection,
      manifest,
      requestedAt: observedNow(clock).toISOString(),
    });
    const current = authorityClient.observeCurrentHead({
      request: requestSet.current,
      now: observedNow(clock),
      expectedDatabaseInstances: expectedInstances,
    });
    const scope = authorityClient.observeScope({
      request: requestSet.scope,
      now: observedNow(clock),
    });
    const challenge = authorityClient.challengeActiveAuthority({
      request: requestSet.challenge,
      now: observedNow(clock),
      expectedDatabaseInstances: expectedInstances,
    });
    if (sameLinearizedHead(current, challenge, scope)) {
      selected = Object.freeze({
        attempt,
        requestSet,
        receipts: Object.freeze({ current, challenge, scope }),
      });
      break;
    }
  }
  if (!selected) fail('autonomous_research_online_mutation_active_refresh_head_unstable');
  const recordedAt = observedNow(clock).toISOString();
  const journalEvidence = journalEntries(selected.requestSet, selected.receipts);
  const authorityEvidence = Object.freeze({
    currentHead: journalEvidence['current-head'],
    activeChallenge: journalEvidence['active-challenge'],
    brokerScope: journalEvidence['broker-scope'],
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationActiveRefreshReceipt',
    status: 'autonomous_research_online_mutation_active_refresh_complete',
    externalActionPerformed: true,
    linearizationAttemptCount: selected.attempt,
    globalSequence: selected.receipts.current.globalSequence,
    globalHash: selected.receipts.current.globalHash,
    currentHeadReceiptHash: autonomousResearchOnlineMutationReceiptHash(
      selected.receipts.current,
    ),
    activeChallengeReceiptHash: autonomousResearchOnlineMutationReceiptHash(
      selected.receipts.challenge,
    ),
    brokerScopeReceiptHash: autonomousResearchOnlineMutationReceiptHash(
      selected.receipts.scope,
    ),
    authorityEvidence,
    journalRecorded: false,
    journalReceipt: null,
    recordedAt,
  });
}
