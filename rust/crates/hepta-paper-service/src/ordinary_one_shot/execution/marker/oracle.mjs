// Actual incumbent repository. These synthetic business records do not invoke
// a provider or campaign and are not execution qualification.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const from = relative => import(pathToFileURL(path.join(input.source, relative)));
const { executionBinding } = await from('paper-core/tests/support/autonomous-research-one-shot-campaign-attempt-fixture.mjs');
const domain = await from('paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs');
const { createCampaignOneShotAttemptJournalRepository: create } = await from('paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs');
const { createOfflineSqliteStore } = await from('paper-adapters/persistence/sqlite-store.mjs');
const { hashRecord } = await from('workflow-kernel/record-hash.mjs');
const now = '2026-08-03T00:00:00.000Z';
const reservation = domain.buildAutonomousResearchOneShotCampaignAttemptReservation({
  attemptId: 'native-fixed-one-shot-journal', idempotencyKey: hashRecord('JournalAdapterTest', { fixture: 1 }),
  campaignId: executionBinding().targetCampaignDefinition.campaignId,
  protectedCampaignId: executionBinding().protectedCampaignDefinition.campaignId,
  executionBinding: executionBinding(), reservedAt: now,
});
const result = callback => {
  try { return { ok: callback() }; } catch (error) { return { error: error.message }; }
};
function rows() {
  const db = new DatabaseSync(path.join(input.control, 'campaign-one-shot-attempt.sqlite'), { readOnly: true });
  try {
    return Object.fromEntries(['campaign_one_shot_attempt_journal_metadata', 'campaign_one_shot_attempts',
      'campaign_one_shot_attempt_events', 'campaign_one_shot_attempt_terminal_receipts'].map(table => [
      table, db.prepare('SELECT rowid,* FROM ' + table + ' ORDER BY rowid').all(),
    ]));
  } finally { db.close(); }
}
fs.mkdirSync(input.runtime, { mode: 0o755 });
let lose = false;
const options = { runtimeRoot: input.runtime, controlRoot: input.control, create: true, clock: { now: () => new Date(now) } };
const repo = create({ ...options, storeFactory: options => {
  const port = createOfflineSqliteStore(options);
  return { ...port, transaction(callback) {
    const value = port.transaction(callback);
    if (lose) { lose = false; throw new Error('one_shot_oracle_commit_ack_lost'); }
    return value;
  } };
} });
const requests = [];
const outcomes = {};
try {
  const reserved = repo.reserveAttempt({ reservation });
  outcomes.reservationClaim = result(() => repo.assertExternalActionSideEffectPermit({ transition: reserved }));
  let transition;
  for (const phase of ['preconditions_verified', 'prepare_verified', 'provider_started', 'provider_completed', 'launch_started']) {
    const current = repo.inspectAttempt({ attemptId: reservation.attemptId });
    const request = { attemptId: reservation.attemptId, phase, evidence: { kind: 'local_protocol_fixture', phase },
      expectedSequence: current.events.length + 1, expectedPhase: current.headPhase,
      expectedPreviousEventHash: current.headEventHash, recordedAt: now };
    requests.push(request);
    if (phase === input.phase && input.loss) lose = true;
    transition = repo.appendEvent(request);
    if (phase === input.phase) break;
    outcomes[phase + 'Claim'] = result(() => repo.assertExternalActionSideEffectPermit({ transition }));
  }
  const inspection = repo.inspectAttempt({ attemptId: reservation.attemptId });
  outcomes.projectionClaim = result(() => repo.assertExternalActionSideEffectPermit({ transition: inspection }));
  outcomes.copiedClaim = result(() => repo.assertExternalActionSideEffectPermit({ transition: JSON.parse(JSON.stringify(transition)) }));
  const reopened = create({ ...options, create: false });
  try {
    outcomes.foreignClaim = result(() => reopened.assertExternalActionSideEffectPermit({ transition }));
    outcomes.foreignCurrent = result(() => reopened.assertExternalActionMarkerCurrent({ transition }));
  } finally { reopened.close(); }
  outcomes.firstClaim = result(() => repo.assertExternalActionSideEffectPermit({ transition }));
  outcomes.secondClaim = result(() => repo.assertExternalActionSideEffectPermit({ transition }));
  outcomes.current = result(() => repo.assertExternalActionMarkerCurrent({ transition }));
  outcomes.currentAgain = result(() => repo.assertExternalActionMarkerCurrent({ transition }));
  const replay = repo.appendEvent(requests.at(-1));
  outcomes.replayClaim = result(() => repo.assertExternalActionSideEffectPermit({ transition: replay }));
  outcomes.replayCurrent = result(() => repo.assertExternalActionMarkerCurrent({ transition: replay }));
  outcomes.originalAfterReplay = result(() => repo.assertExternalActionMarkerCurrent({ transition }));
  const before = rows();
  const finalize = { attemptId: reservation.attemptId, terminalStatus: 'recovered_incomplete',
    expectedSequence: inspection.events.length + 1, expectedPhase: inspection.headPhase,
    expectedPreviousEventHash: inspection.headEventHash, completedAt: now,
    outcome: { kind: 'local_protocol_fixture', status: 'recovered_incomplete' } };
  const terminal = repo.finalizeAttempt(finalize);
  outcomes.terminalClaim = result(() => repo.assertExternalActionSideEffectPermit({ transition: terminal }));
  outcomes.afterTerminal = result(() => repo.assertExternalActionMarkerCurrent({ transition }));
  const after = rows();
  process.stdout.write(JSON.stringify({ reservation, requests, inspection, outcomes, before, finalize, terminal, after }));
} finally { repo.close(); }
