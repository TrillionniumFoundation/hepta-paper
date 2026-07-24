import {
  NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS,
} from '../persistence/native-store-quality-release-mutation-plan.mjs';

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const PROPOSED_FIX = Object.freeze({
  theorem_proof_status_missing: 'Create proof_status.md and bind every stated theorem to a closed or explicitly open obligation.',
  theorem_evidence_manifest_missing: 'Create evidence_manifest.md and bind theorem claims to source/proof evidence.',
  theorem_statement_missing: 'Add the exact theorem statement or select a non-theorem quality profile.',
  theorem_proof_environment_missing: 'Replace proof prose with a complete proof environment or narrow the claim.',
  theorem_proof_skeleton_present: 'Complete or remove proof-sketch and conditional-proof markers.',
  theorem_open_proof_obligations_present: 'Close every row under Still Open before convergence.',
  theorem_appendix_or_supplement_missing: 'Add the proof appendix/supplement or record an explicit justified waiver.',
  theorem_evidence_manifest_disclaims_support: 'Narrow the theorem claim or supply evidence that actually entails it.',
});

export function createTheoremQualityRevisionSink({ store, clock = { nowIso: () => new Date().toISOString() } } = {}) {
  if (!store?.execute) throw new Error('writable store is required');
  return Object.freeze({
    record({ paperId, report, sourceWorkspace = '' } = {}) {
      if (!paperId || report?.passed !== false || !Array.isArray(report.blockers)) return { status: 'theorem_quality_revision_not_required', requestCount: 0 };
      const now = clock.nowIso();
      if (typeof store.mutate === 'function') {
        const coordinated = store.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.theorem-quality-revision-sink.record.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            let changes = 0;
            for (const blocker of report.blockers) {
              const requestKey = `theorem-readiness:${blocker}`;
              const metadata = JSON.stringify({
                source: 'hepta_theorem_manuscript_readiness_policy',
                blocker,
                policyHash: report.theoremManuscriptReadinessPolicyHash,
                recordedAt: now,
              });
              changes += transaction.run(
                NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS
                  .upsertTheoremQualityRevision,
                paperId,
                requestKey,
                blocker,
                sourceWorkspace,
                report.theoremManuscriptReadinessPolicyHash,
                PROPOSED_FIX[blocker]
                  || 'Resolve the theorem manuscript readiness blocker.',
                now,
                metadata,
                now,
              ).changes;
            }
            return changes;
          },
        });
        if (![
          'externally_fenced_sqlite_mutation_finalized',
          'externally_fenced_sqlite_mutation_no_change',
        ].includes(coordinated?.status)
          || coordinated.value !== report.blockers.length) {
          throw new Error('theorem_quality_revision_external_mutation_receipt_invalid');
        }
        return {
          status: 'theorem_quality_revision_requests_materialized',
          requestCount: report.blockers.length,
          policyHash: report.theoremManuscriptReadinessPolicyHash,
        };
      }
      const statements = ['BEGIN IMMEDIATE;'];
      for (const blocker of report.blockers) {
        const requestKey = `theorem-readiness:${blocker}`;
        const metadata = JSON.stringify({ source: 'hepta_theorem_manuscript_readiness_policy', blocker, policyHash: report.theoremManuscriptReadinessPolicyHash, recordedAt: now });
        statements.push(`
INSERT INTO referee_revision_requests
  (slug,request_key,status,risk_class,objection,source_locator,evidence_locator,proposed_fix,evidence_needed,verification,patch_scope,assignee,state_reason,last_transition_at,metadata_json)
VALUES
  (${sql(paperId)},${sql(requestKey)},'requested','theorem_readiness',${sql(blocker)},${sql(sourceWorkspace)},${sql(report.theoremManuscriptReadinessPolicyHash)},${sql(PROPOSED_FIX[blocker] || 'Resolve the theorem manuscript readiness blocker.')},'source-bound proof/evidence','rerun theorem manuscript readiness policy','manuscript_and_proof_evidence','campaign-reviser','materialized_by_theorem_quality_gate',${sql(now)},${sql(metadata)})
ON CONFLICT(slug,request_key) DO UPDATE SET
  status='requested',objection=excluded.objection,evidence_locator=excluded.evidence_locator,
  proposed_fix=excluded.proposed_fix,state_reason=excluded.state_reason,last_transition_at=excluded.last_transition_at,
  metadata_json=excluded.metadata_json,updated_at=datetime('now');`);
      }
      statements.push('COMMIT;');
      const result = store.execute(statements.join('\n'));
      if (!result.ok) throw new Error(result.error || result.stderr || 'theorem_quality_revision_materialization_failed');
      return { status: 'theorem_quality_revision_requests_materialized', requestCount: report.blockers.length, policyHash: report.theoremManuscriptReadinessPolicyHash };
    },
  });
}
