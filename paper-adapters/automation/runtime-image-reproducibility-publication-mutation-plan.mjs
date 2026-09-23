import {
  compileExternallyFencedSqliteMutationOperation as operation,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';

export const RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE =
  'runtime-reproducibility-publication';
export const RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_INSTANCE_ID =
  'runtime-reproducibility-publication';
export const RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_SCHEMA_CONTRACT_ID =
  'runtime-reproducibility-publication-schema-v1';
export const RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID =
  'writer:runtime-reproducibility-publication:receipt-repository:v1';
export const RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID =
  'runtime-reproducibility-publication.receipt-repository.publish.v1';

export const RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS = Object.freeze({
  [RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID]: operation(
    RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
    [
      {
        statementId: 'runtime-publication.current.get.v1',
        mode: 'get',
        sql: `SELECT receipt_json,receipt_content_hash,receipt_hash,
          issued_at,expires_at,publication_generation,updated_at
          FROM runtime_image_reproducibility_receipt WHERE singleton_id=1`,
      },
      {
        statementId: 'runtime-publication.receipt.upsert.v1',
        mode: 'run',
        sql: `INSERT INTO runtime_image_reproducibility_receipt(
          singleton_id,receipt_json,receipt_content_hash,receipt_hash,issued_at,expires_at,
          publication_generation,updated_at
        ) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET
          receipt_json=excluded.receipt_json,
          receipt_content_hash=excluded.receipt_content_hash,
          receipt_hash=excluded.receipt_hash,
          issued_at=excluded.issued_at,
          expires_at=excluded.expires_at,
          publication_generation=excluded.publication_generation,
          updated_at=excluded.updated_at`,
      },
    ],
  ),
});

export const RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
    operationPlans: Object.values(
      RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS,
    ),
  });

export function createOfflineRuntimeImageReproducibilityPublicationMutationCoordinator({
  operationPlans = RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS,
  databaseInstanceId = RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_INSTANCE_ID,
  schemaContractId = RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_SCHEMA_CONTRACT_ID,
  writerId = RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'runtime_reproducibility_publication_offline_mutation_input_invalid',
    asyncMutationError:
      'runtime_reproducibility_publication_async_mutation_forbidden',
    recoveryUnavailableError:
      'runtime_reproducibility_publication_offline_recovery_unavailable',
    statusBlocker:
      'runtime_reproducibility_publication_external_mutation_coordinator_required',
    receiptKind: 'OfflineRuntimeImageReproducibilityPublicationMutationReceipt',
  });
}
