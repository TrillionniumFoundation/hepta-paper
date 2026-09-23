import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  NATIVE_STORE_DATABASE_INSTANCE_ID,
  NATIVE_STORE_SCHEMA_CONTRACT_ID,
} from '../../paper-adapters/persistence/native-store-online-mutation-plan.mjs';
import {
  openExistingExternallyFencedPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';

const NATIVE_STORE_ROLE = 'native-store';

export function autonomousResearchNativeStoreOnlineMutationRouting({
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} = {}) {
  const checked = assertAutonomousResearchOnlineWriterOperationManifest(manifest);
  if (!checked.coverage.coveredDatabaseRoles.includes(NATIVE_STORE_ROLE)) {
    throw new Error('autonomous_research_native_store_writer_coverage_required');
  }
  const writers = checked.writers.filter((writer) => (
    writer.databaseRoles.includes(NATIVE_STORE_ROLE)
  ));
  const operationWriters = Object.fromEntries(writers.flatMap((writer) => (
    writer.operationIds.map((operationId) => [operationId, writer.writerId])
  )));
  const operationIds = Object.keys(operationWriters).sort();
  const integratedNativeOperationIds = checked.operations
    .filter((operation) => (
      operation.databaseRole === NATIVE_STORE_ROLE
      && operation.coordinatorIntegrated === true
    ))
    .map((operation) => operation.operationId)
    .sort();
  if (writers.length === 0
    || operationIds.length === 0
    || operationIds.join('\0') !== integratedNativeOperationIds.join('\0')) {
    throw new Error('autonomous_research_native_store_writer_routing_incomplete');
  }
  return Object.freeze({
    databaseRole: NATIVE_STORE_ROLE,
    databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
    schemaContractId: NATIVE_STORE_SCHEMA_CONTRACT_ID,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(checked),
    writerIds: Object.freeze(writers.map((writer) => writer.writerId).sort()),
    operationIds: Object.freeze(operationIds),
    operationWriters: Object.freeze(operationWriters),
  });
}

export function openAutonomousResearchExternallyFencedPaperStore({
  root,
  runtimeRoot,
  mutationCoordinator,
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  maxBuffer,
} = {}) {
  const routing = autonomousResearchNativeStoreOnlineMutationRouting({ manifest });
  return openExistingExternallyFencedPaperStore({
    root,
    runtimeRoot,
    maxBuffer,
    mutationCoordinator,
    databaseInstanceId: routing.databaseInstanceId,
    schemaContractId: routing.schemaContractId,
    operationIds: routing.operationIds,
    operationWriters: routing.operationWriters,
  });
}
