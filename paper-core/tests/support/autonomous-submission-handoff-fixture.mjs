import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  resolveAutonomousSubmissionHandoffStateDatabaseInventory,
} from '../../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  fileSha256HashSync,
} from '../../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  openAutonomousSubmissionHandoffStore,
} from '../../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import {
  convergeAutonomousSubmissionHandoff,
} from '../../../paper-composition/bootstrap/autonomous-submission-handoff-migration-composition.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname), '..', '..', '..',
);

export function createReadOnlyAutonomousSubmissionHandoffOutboxFixture() {
  const unavailable = () => {
    throw new Error('autonomous_submission_handoff_test_outbox_write_forbidden');
  };
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionHandoffOutboxPort',
    durability: 'sqlite-transactional-outbox-v1',
    externallyFencedMutations: false,
    prepareAutonomousSubmission: unavailable,
    beginAutonomousSubmissionAttempt: unavailable,
    recordAutonomousSubmissionOutcome: unavailable,
    getAutonomousSubmission: () => null,
    listAutonomousSubmissionsForCampaign: () => Object.freeze([]),
    listDispatchableAutonomousSubmissions: () => Object.freeze([]),
  });
}

export function provisionAutonomousSubmissionHandoffTestAuthority({
  root,
  runtimeRoot,
  nativeStore,
  now = new Date(),
} = {}) {
  convergeAutonomousSubmissionHandoff({ nativeStore, runtimeRoot, now });
  const handoffStore = openAutonomousSubmissionHandoffStore({ runtimeRoot });
  try {
    for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
      const result = handoffStore.execute(statement);
      if (!result.ok) throw new Error(result.error || 'submission_handoff_test_schema_failed');
    }
    handoffStore.checkpoint({ mode: 'TRUNCATE' });
  } finally {
    handoffStore.close();
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(
    WORKSPACE_ROOT,
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  ), 'utf8'));
  const inventory = resolveAutonomousSubmissionHandoffStateDatabaseInventory({
    runtimeRoot,
    manifest,
  });
  if (inventory.status !== 'autonomous_research_state_database_inventory_ready') {
    throw new Error(`submission_handoff_test_inventory_blocked:${inventory.blockers.join(',')}`);
  }
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(root, 'submission-handoff-test-public-key.json');
  const authorityConfigurationPath = path.join(root, 'submission-handoff-test-authority.json');
  const commandPath = path.join(root, 'submission-handoff-test-authority.mjs');
  const processConfigurationPath = path.join(root, 'submission-handoff-test-process.json');
  fs.writeFileSync(publicKeyPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityPublicKey',
    authorityId: 'authority:submission-handoff-test',
    keyId: 'key:submission-handoff-test',
    algorithm: 'ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  }), { mode: 0o600 });
  fs.writeFileSync(authorityConfigurationPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityConfiguration',
    authorityId: 'authority:submission-handoff-test',
    keyId: 'key:submission-handoff-test',
    scopeId: 'scope:submission-handoff-test',
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
    publicKeyPath,
    publicKeySha256: fileSha256HashSync(publicKeyPath),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  }), { mode: 0o600 });
  fs.writeFileSync(commandPath, '#!/usr/bin/env node\nprocess.exitCode = 70;\n', {
    mode: 0o700,
  });
  fs.writeFileSync(processConfigurationPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',
    authorityConfigurationPath,
    authorityConfigurationSha256: fileSha256HashSync(authorityConfigurationPath),
    commandPath,
    commandSha256: fileSha256HashSync(commandPath),
    fixedArguments: [],
    timeoutMs: 10_000,
  }), { mode: 0o600 });
  return processConfigurationPath;
}
