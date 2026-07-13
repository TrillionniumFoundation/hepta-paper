import path from 'node:path';
import { ensureDir, relativePath } from '../../workflow-kernel/runtime/file-utils.mjs';
import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { buildJournalConferenceRegistry, buildTargetSelectionPolicy, buildJournalTargetProfile, buildJournalRubricPacket, buildVenueRubricManager, buildFreshRefereePool, buildVenueEvidenceGate, buildVenueLifecyclePolicy, buildJournalConferenceSystemPacket, buildFreshRefereeVerdict } from './contracts.mjs';

export { JOURNAL_PROFILES } from './journal-registry.mjs';
export { resolveJournalProfile } from './selection.mjs';
export { buildJournalConferenceRegistry, buildTargetSelectionPolicy, buildJournalTargetProfile, buildJournalRubricPacket, buildVenueRubricManager, buildFreshRefereePool, buildVenueEvidenceGate, buildVenueLifecyclePolicy, buildJournalConferenceSystemPacket, buildFreshRefereeVerdict } from './contracts.mjs';

export async function runJournalManageAdapter({
  root = null,
  runtimeRoot = null,
  row = null,
  target = null,
  hints = [],
  researchReport = null,
  packageResult = null,
  lifecycle = null,
  roundIndex = null,
  execute = false,
} = {}) {
  const registry = buildJournalConferenceRegistry();
  const targetSelectionPolicy = buildTargetSelectionPolicy({
    paperTask: row?.task || null,
    target: target || row?.task?.venueTarget || null,
    hints,
    registry,
  });
  const targetProfile = buildJournalTargetProfile({
    paperTask: row?.task || null,
    target: target || row?.task?.venueTarget || null,
    registry,
    targetSelectionPolicy,
    hints,
  });
  const freshRefereePool = buildFreshRefereePool({
    paperTask: row?.task || null,
    targetProfile,
    roundIndex: roundIndex || 1,
  });
  const venueRubricManager = buildVenueRubricManager({
    paperTask: row?.task || null,
    targetProfile,
    targetSelectionPolicy,
    roundIndex,
    refereePool: freshRefereePool,
  });
  const rubricPacket = buildJournalRubricPacket({
    paperTask: row?.task || null,
    targetProfile,
    targetSelectionPolicy,
    venueRubricManager,
    refereePool: freshRefereePool,
    roundIndex,
  });
  const evidenceGate = buildVenueEvidenceGate({
    paperTask: row?.task || null,
    targetProfile,
    venueRubricManager,
    researchReport,
    packageResult,
  });
  const lifecyclePolicy = buildVenueLifecyclePolicy({
    paperTask: row?.task || null,
    targetProfile,
    evidenceGate,
    lifecycle,
  });
  const systemPacket = buildJournalConferenceSystemPacket({
    paperTask: row?.task || null,
    registry,
    targetSelectionPolicy,
    targetProfile,
    rubricPacket,
    venueRubricManager,
    freshRefereePool,
    evidenceGate,
    lifecyclePolicy,
  });
  if (runtimeRoot && row?.task?.paperId && execute) {
    const dir = path.join(runtimeRoot, 'journal-manage', row.task.paperId);
    await ensureDir(dir);
    await writeJsonFile(path.join(dir, 'JOURNAL_CONFERENCE_REGISTRY.json'), registry);
    await writeJsonFile(path.join(dir, 'TARGET_SELECTION_POLICY.json'), targetSelectionPolicy);
    await writeJsonFile(path.join(dir, 'JOURNAL_TARGET_PROFILE.json'), targetProfile);
    await writeJsonFile(path.join(dir, 'JOURNAL_RUBRIC_PACKET.json'), rubricPacket);
    await writeJsonFile(path.join(dir, 'VENUE_RUBRIC_MANAGER.json'), venueRubricManager);
    await writeJsonFile(path.join(dir, 'FRESH_REFEREE_POOL.json'), freshRefereePool);
    await writeJsonFile(path.join(dir, 'VENUE_EVIDENCE_GATE.json'), evidenceGate);
    await writeJsonFile(path.join(dir, 'VENUE_LIFECYCLE_POLICY.json'), lifecyclePolicy);
    await writeJsonFile(path.join(dir, 'JOURNAL_CONFERENCE_SYSTEM_PACKET.json'), systemPacket);
  }
  const report = {
    version: 1,
    kind: 'JournalManageAdapterReport',
    paperId: row?.task?.paperId || null,
    taskKey: row?.task?.taskKey || null,
    status: systemPacket.status === 'journal_conference_system_ready'
      ? 'journal_manage_ready'
      : 'journal_manage_blocked',
    registry,
    targetSelectionPolicy,
    targetProfile,
    rubricPacket,
    venueRubricManager,
    freshRefereePool,
    evidenceGate,
    lifecyclePolicy,
    systemPacket,
    source: {
      runtimeDir: runtimeRoot && row?.task?.paperId
        ? relativePath(root || path.dirname(runtimeRoot), path.join(runtimeRoot, 'journal-manage', row.task.paperId))
        : null,
    },
    safety: {
      localOnly: true,
      writesLegacyRegistry: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
  };
  return {
    ...report,
    journalManageAdapterReportHash: hashPaperRecord('JournalManageAdapterReport', report),
  };
}
