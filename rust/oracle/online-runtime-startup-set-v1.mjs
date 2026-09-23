// Test-only Node oracle for the native all-database startup-set projection.
import fs from 'node:fs';
import { autonomousResearchOnlineMutationReceiptHash } from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  const report = input.report;
  if (report?.version !== 1
      || report.kind !== 'AutonomousResearchOnlineMutationStartupReconciliationSetReceipt'
      || report.status !== 'autonomous_research_online_mutation_startup_reconciliation_set_reconciled'
      || report.runtimeReady !== false
      || report.databaseCount !== 10
      || !Array.isArray(report.reconciliations)
      || report.reconciliations.length !== 10) throw new Error('startup_set_invalid');
  const hashes = report.reconciliations.map((row) => ({
    databaseRole: row.databaseRole,
    databaseInstanceId: row.databaseInstanceId,
    reconciliationReceiptHash: autonomousResearchOnlineMutationReceiptHash(row.receipt),
  }));
  process.stdout.write(JSON.stringify({ ok: true, databaseCount: report.databaseCount, hashes }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}
