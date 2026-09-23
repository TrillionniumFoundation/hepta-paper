import {
  applyNativeStoreCampaignMutation,
} from './native-store-campaign-mutation-execution.mjs';

export function createSqliteCampaignMutationBoundary({ store } = {}) {
  const casGuard = 'campaign_cas_guard';

  const guarded = (statement) => (
    `DELETE FROM ${casGuard}; ${statement} INSERT INTO ${casGuard}(changed) VALUES(changes());`
  );

  const legacyTransaction = (
    statements,
    fallback,
    packageDeletionWriterSelector = null,
  ) => {
    const sql = `BEGIN IMMEDIATE; CREATE TEMP TABLE IF NOT EXISTS ${casGuard}(changed INTEGER NOT NULL CHECK(changed=1)); ${statements.join(' ')} COMMIT;`;
    const result = store.execute(sql, packageDeletionWriterSelector ? {
      packageDeletionWriterSelector,
    } : undefined);
    if (!result.ok) {
      const error = new Error(`${fallback}:${result.error || result.stderr || 'transaction_failed'}`);
      error.code = fallback;
      throw error;
    }
    return result;
  };

  const mutation = ({
    databaseRole,
    operationId,
    statements,
    fallback,
    input,
    packageDeletionWriterSelector = null,
  } = {}) => {
    if (databaseRole !== 'native-store') {
      throw new Error('campaign_mutation_database_role_invalid');
    }
    if (typeof store.mutate !== 'function') {
      return legacyTransaction(
        statements,
        fallback,
        packageDeletionWriterSelector,
      );
    }
    try {
      const receipt = store.mutate({
        operationId,
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        ...(packageDeletionWriterSelector ? {
          packageDeletionWriterSelector,
        } : {}),
        mutate: (transaction) => applyNativeStoreCampaignMutation(
          transaction,
          operationId,
          input,
        ),
      });
      if (![
        'externally_fenced_sqlite_mutation_finalized',
        'externally_fenced_sqlite_mutation_no_change',
      ].includes(receipt?.status)) {
        throw new Error('campaign_external_mutation_receipt_invalid');
      }
      return receipt.value;
    } catch (error) {
      if (error?.committed === true
        || error?.stateRecoverabilityFatal === true
        || error?.stateRecoverabilityDeferred === true
        || error?.authorityEvidenceRenewalFatal === true
        || error?.authorityEvidenceRenewalDeferred === true
        || error?.residentReactivationRequired === true) throw error;
      const wrapped = new Error(`${fallback}:${error?.message || 'transaction_failed'}`);
      wrapped.code = fallback;
      wrapped.cause = error;
      throw wrapped;
    }
  };

  return Object.freeze({ guarded, mutation });
}
