import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const from = relative => import(pathToFileURL(path.join(input.source,relative)));
const { executionBinding } = await from('paper-core/tests/support/autonomous-research-one-shot-campaign-attempt-fixture.mjs');
const domain = await from('paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs');
const { createCampaignOneShotAttemptJournalRepository: create } = await from('paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs');
const { createOfflineSqliteStore } = await from('paper-adapters/persistence/sqlite-store.mjs');
const { hashRecord } = await from('workflow-kernel/record-hash.mjs');
const now = '2026-08-03T00:00:00.000Z';
const reservation = domain.buildAutonomousResearchOneShotCampaignAttemptReservation({
  attemptId: 'native-fixed-one-shot-journal', idempotencyKey: hashRecord('JournalAdapterTest',{fixture:1}),
  campaignId: executionBinding().targetCampaignDefinition.campaignId,
  protectedCampaignId: executionBinding().protectedCampaignDefinition.campaignId,
  executionBinding: executionBinding(), reservedAt: now,
});
function observedRows(control) {
  const db = new DatabaseSync(path.join(control,'campaign-one-shot-attempt.sqlite'),{readOnly:true});
  try { return Object.fromEntries(['campaign_one_shot_attempt_journal_metadata','campaign_one_shot_attempts',
    'campaign_one_shot_attempt_events','campaign_one_shot_attempt_terminal_receipts'].map(table => [
    table, db.prepare('SELECT rowid,* FROM '+table+' ORDER BY rowid').all(),
  ])); } finally { db.close(); }
}
if (input.mode === 'inspect') {
  const existing = create({runtimeRoot:input.runtime,controlRoot:input.control,create:false});
  try { await new Promise((resolve,reject) => process.stdout.write(JSON.stringify({report:existing.inspectAttempt({attemptId:reservation.attemptId}),rows:observedRows(input.control)}), error => error ? reject(error) : resolve())); }
  finally { existing.close(); }
  process.exit(0);
}
const terminalMode = input.mode.startsWith('terminal/');
const [, terminalPhase, terminalStatus] = input.mode.split('/');
const reports = []; const requests = []; const transitions = [];
let lose = false; let failBefore = false;
fs.mkdirSync(input.runtime,{mode:0o755});
const repo = create({runtimeRoot:input.runtime,controlRoot:input.control,create:true,
  clock:{now:()=>new Date(now)},
  storeFactory: options => {
    const port = createOfflineSqliteStore(options);
    return {...port,transaction(callback) {
      const value = port.transaction(callback);
      if (lose) {lose=false;throw new Error('one_shot_oracle_commit_ack_lost');}
      return value;
    }};
  },
  faultInjection:{beforeCommit({operation}) {
    if (failBefore && operation === 'append') {failBefore=false;throw new Error('one_shot_oracle_before_commit');}
  }},
});
try {
  reports.push(repo.reserveAttempt({reservation}));
  reports.push(repo.reserveAttempt({reservation}));
  for (const phase of ['preconditions_verified','prepare_verified','provider_started','provider_completed','launch_started']) {
    const current = repo.inspectAttempt({attemptId:reservation.attemptId});
    if (terminalMode && current.headPhase === terminalPhase) break;
    const request = {attemptId:reservation.attemptId,phase,evidence:{kind:'local_protocol_fixture',phase},
      expectedSequence:current.events.length+1,expectedPhase:current.headPhase,
      expectedPreviousEventHash:current.headEventHash,recordedAt:now};
    if (input.mode === 'loss' && phase === 'provider_started') lose=true;
    if (input.mode === 'rollback' && phase === 'provider_started') failBefore=true;
    requests.push(request);
    try {
      transitions.push(repo.appendEvent(request));
      reports.push(repo.inspectAttempt({attemptId:reservation.attemptId}));
    } catch(error) {
      transitions.push({error:error.message});
      reports.push(repo.inspectAttempt({attemptId:reservation.attemptId}));
      break;
    }
    if (phase === 'provider_started' && input.mode === 'loss') break;
  }
  let finalize = null;
  if (input.mode === 'normal' || terminalMode) {
    const current = repo.inspectAttempt({attemptId:reservation.attemptId});
    if (terminalMode && current.headPhase !== terminalPhase) throw new Error('one_shot_oracle_terminal_phase_invalid');
    const status = terminalMode ? terminalStatus : 'completed';
    finalize = {attemptId:reservation.attemptId,terminalStatus:status,
      expectedSequence:current.events.length+1,expectedPhase:current.headPhase,
      expectedPreviousEventHash:current.headEventHash,completedAt:now,outcome:{kind:'local_protocol_fixture',status}};
    reports.push(repo.finalizeAttempt(finalize));
    reports.push(repo.finalizeAttempt(finalize));
  }
  repo.close();
  const db = new DatabaseSync(path.join(input.control,'campaign-one-shot-attempt.sqlite'),{readOnly:true});
  const rows = Object.fromEntries(['campaign_one_shot_attempt_journal_metadata','campaign_one_shot_attempts',
    'campaign_one_shot_attempt_events','campaign_one_shot_attempt_terminal_receipts'].map(table => [
    table, db.prepare('SELECT rowid,* FROM '+table+' ORDER BY rowid').all(),
  ]));
  db.close();
  process.stdout.write(JSON.stringify({reservation,requests,transitions,reports,finalize,rows}));
} finally {repo.close();}
