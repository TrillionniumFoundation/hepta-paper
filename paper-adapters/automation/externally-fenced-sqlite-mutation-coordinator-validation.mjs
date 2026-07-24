import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  validateExternallyFencedSqliteMutationPlans,
} from './externally-fenced-sqlite-mutation-plan.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code) {
  throw new Error(code);
}

export function validateExternallyFencedSqliteMutationCoordinatorFactory({
  authorityClient,
  authorityTrust,
  manifest,
  databaseInstances,
  operationPlans,
  recoverabilityEpochFence,
}) {
  const checkedManifest = assertAutonomousResearchOnlineWriterOperationManifest(manifest);
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(checkedManifest);
  if (!authorityClient
    || authorityClient.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || authorityClient.trust !== authorityTrust
    || typeof authorityClient.observeCurrentHead !== 'function'
    || typeof authorityClient.reserveMutation !== 'function'
    || typeof authorityClient.verifyStoredReservation !== 'function'
    || typeof authorityClient.finalizeMutation !== 'function'
    || typeof authorityClient.abortMutation !== 'function'
    || typeof authorityClient.resolveMutationAttempt !== 'function'
    || (recoverabilityEpochFence !== null
      && (typeof recoverabilityEpochFence?.markMutationFinalized !== 'function'
        || typeof recoverabilityEpochFence?.markMutationReconciliationRequired !== 'function'
        || typeof recoverabilityEpochFence?.assertCurrent !== 'function'
        || typeof recoverabilityEpochFence?.reconcile !== 'function'))
    || authorityTrust?.writerManifestHash !== manifestHash
    || !Array.isArray(databaseInstances)
    || databaseInstances.length === 0) {
    fail('externally_fenced_sqlite_mutation_coordinator_configuration_invalid');
  }
  const checkedPlans = validateExternallyFencedSqliteMutationPlans({
    manifest: checkedManifest,
    operationPlans,
  });
  return Object.freeze({ checkedManifest, manifestHash, checkedPlans });
}

export function validateExternallyFencedSqliteMutationInput(
  input,
  manifest,
  authorityTrust,
  plans,
) {
  const operation = manifest.operations.find((candidate) => (
    candidate.operationId === input?.operationId
  ));
  const writer = manifest.writers.find((candidate) => (
    candidate.writerId === input?.writerId
    && candidate.operationIds.includes(input?.operationId)
  ));
  const plan = plans.byOperationId.get(input?.operationId);
  if (!input?.database
    || typeof input.database.exec !== 'function'
    || typeof input.mutate !== 'function'
    || !operation?.coordinatorIntegrated
    || operation.databaseRole !== input.databaseRole
    || !writer
    || !plan
    || (input.codeProvenanceHash !== undefined
      && writer.implementationHash !== input.codeProvenanceHash)
    || !SHA256.test(String(writer.implementationHash || ''))
    || typeof input.databaseInstanceId !== 'string'
    || input.databaseInstanceId.length === 0
    || typeof input.schemaContractId !== 'string'
    || input.schemaContractId.length === 0
    || !Array.isArray(input.authorizationReceiptHashes)
    || !Array.isArray(input.sideEffectReservationHashes)
    || authorityTrust.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(manifest)) {
    fail('externally_fenced_sqlite_mutation_input_invalid');
  }
  return Object.freeze({ operation, writer, plan });
}
