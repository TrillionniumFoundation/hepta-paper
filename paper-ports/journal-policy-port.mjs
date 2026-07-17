const JOURNAL_POLICY_METHODS = Object.freeze([
  'freshRefereePool',
  'freshRefereeVerdict',
  'journalConferenceRegistry',
  'journalConferenceSystemPacket',
  'journalRubricPacket',
  'journalTargetProfile',
  'targetSelectionPolicy',
  'venueEvidenceGate',
  'venueLifecyclePolicy',
  'venueRubricManager',
]);

export function assertJournalPolicyPort(port) {
  if (Number(port?.version || 0) < 1) throw new Error('JournalPolicyPort.version 1 is required');
  for (const method of JOURNAL_POLICY_METHODS) {
    if (typeof port?.[method] !== 'function') throw new Error(`JournalPolicyPort.${method} is required`);
  }
  return port;
}

export { JOURNAL_POLICY_METHODS };
