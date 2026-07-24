import {
  compileExternallyFencedSqliteMutationOperation as operation,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';

export const FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE =
  'full-research-qualification-publication';
export const FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_INSTANCE_ID =
  'full-research-qualification-publication';
export const FULL_RESEARCH_QUALIFICATION_PUBLICATION_SCHEMA_CONTRACT_ID =
  'full-research-qualification-publication-schema-v1';
export const FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID =
  'writer:full-research-qualification-publication:receipt-pointer-repository:v1';

export const FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS = Object.freeze({
  acquire:
    'full-research-qualification-publication.receipt-pointer-repository.tryAcquirePublicationLease.v1',
  publish:
    'full-research-qualification-publication.receipt-pointer-repository.publish.v1',
  release:
    'full-research-qualification-publication.receipt-pointer-repository.releasePublicationLease.v1',
  renew:
    'full-research-qualification-publication.receipt-pointer-repository.renewPublicationLease.v1',
});

export const FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS = Object.freeze({
  [FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.acquire]: operation(
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.acquire,
    [
      {
        statementId: 'qualification-publication.acquire.lease-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM full_research_qualification_pointer_lease
          WHERE singleton_id=1`,
      },
      {
        statementId: 'qualification-publication.acquire.lease-update.apply.v1',
        mode: 'run',
        sql: `UPDATE full_research_qualification_pointer_lease SET
          lease_owner=?,lease_token=?,lease_generation=?,lease_expires_at=?,
          recovered_lease_count=recovered_lease_count+?,updated_at=?
          WHERE singleton_id=1 AND lease_generation=?`,
      },
    ],
  ),
  [FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish]: operation(
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish,
    [
      {
        statementId: 'qualification-publication.publish.authority-current.get.v1',
        mode: 'get',
        sql: `SELECT * FROM full_research_qualification_pointer_authority
          WHERE singleton_id=1`,
      },
      {
        statementId: 'qualification-publication.publish.authority-upsert.apply.v1',
        mode: 'run',
        sql: `INSERT INTO full_research_qualification_pointer_authority(
          singleton_id,receipt_json,receipt_content_hash,receipt_hash,runtime_receipt_hash,
          qualification_state_hash,qualification_state_generation,publisher_scope,
          publisher_owner_id,publisher_lease_generation,issued_at,expires_at,
          publication_generation,updated_at
        ) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET
          receipt_json=excluded.receipt_json,
          receipt_content_hash=excluded.receipt_content_hash,
          receipt_hash=excluded.receipt_hash,
          runtime_receipt_hash=excluded.runtime_receipt_hash,
          qualification_state_hash=excluded.qualification_state_hash,
          qualification_state_generation=excluded.qualification_state_generation,
          publisher_scope=excluded.publisher_scope,
          publisher_owner_id=excluded.publisher_owner_id,
          publisher_lease_generation=excluded.publisher_lease_generation,
          issued_at=excluded.issued_at,
          expires_at=excluded.expires_at,
          publication_generation=excluded.publication_generation,
          updated_at=excluded.updated_at`,
      },
      {
        statementId: 'qualification-publication.publish.lease-assert.get.v1',
        mode: 'get',
        sql: `SELECT * FROM full_research_qualification_pointer_lease
          WHERE singleton_id=1`,
      },
    ],
  ),
  [FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.release]: operation(
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.release,
    [{
      statementId: 'qualification-publication.release.lease-update.apply.v1',
      mode: 'run',
      sql: `UPDATE full_research_qualification_pointer_lease SET
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE singleton_id=1 AND lease_owner=? AND lease_token=? AND lease_generation=?`,
    }],
  ),
  [FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.renew]: operation(
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.renew,
    [{
      statementId: 'qualification-publication.renew.lease-update.apply.v1',
      mode: 'run',
      sql: `UPDATE full_research_qualification_pointer_lease SET
        lease_expires_at=?,updated_at=? WHERE singleton_id=1 AND lease_owner=?
        AND lease_token=? AND lease_generation=? AND julianday(lease_expires_at)>julianday(?)`,
    }],
  ),
});

export const FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
    operationPlans: Object.values(FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS),
  });

export function createOfflineFullResearchQualificationPublicationMutationCoordinator({
  operationPlans = FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS,
  databaseInstanceId = FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_INSTANCE_ID,
  schemaContractId = FULL_RESEARCH_QUALIFICATION_PUBLICATION_SCHEMA_CONTRACT_ID,
  writerId = FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'full_research_qualification_publication_offline_mutation_input_invalid',
    asyncMutationError:
      'full_research_qualification_publication_async_mutation_forbidden',
    recoveryUnavailableError:
      'full_research_qualification_publication_offline_recovery_unavailable',
    statusBlocker:
      'full_research_qualification_publication_external_mutation_coordinator_required',
    receiptKind: 'OfflineFullResearchQualificationPublicationMutationReceipt',
  });
}
