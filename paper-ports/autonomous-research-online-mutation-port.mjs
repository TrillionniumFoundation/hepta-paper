export function assertAutonomousResearchOnlineAuthorityJournalInstallerPort(installer) {
  if (typeof installer?.installAuthorityJournalSchema !== 'function') {
    throw new Error(
      'AutonomousResearchOnlineAuthorityJournalInstallerPort.installAuthorityJournalSchema is required',
    );
  }
  return installer;
}

export function assertAutonomousResearchOnlineAuthorityJournalReaderPort(reader) {
  if (typeof reader?.readPassiveAuthorityEvidence !== 'function') {
    throw new Error(
      'AutonomousResearchOnlineAuthorityJournalReaderPort.readPassiveAuthorityEvidence is required',
    );
  }
  return reader;
}

export function assertAutonomousResearchOnlineAuthorityJournalWriterPort(writer) {
  if (typeof writer?.recordActiveAuthorityEvidence !== 'function') {
    throw new Error(
      'AutonomousResearchOnlineAuthorityJournalWriterPort.recordActiveAuthorityEvidence is required',
    );
  }
  return writer;
}

export function assertAutonomousResearchOnlineAuthorityEvidenceCacheReaderPort(reader) {
  if (typeof reader?.readPassiveAuthorityEvidence !== 'function') {
    throw new Error(
      'AutonomousResearchOnlineAuthorityEvidenceCacheReaderPort.readPassiveAuthorityEvidence is required',
    );
  }
  return reader;
}

export function assertAutonomousResearchOnlineAuthorityEvidenceCacheWriterPort(writer) {
  if (typeof writer?.recordActiveAuthorityEvidence !== 'function') {
    throw new Error(
      'AutonomousResearchOnlineAuthorityEvidenceCacheWriterPort.recordActiveAuthorityEvidence is required',
    );
  }
  return writer;
}

export function assertExternallyFencedSqliteMutationCoordinatorPort(coordinator) {
  for (const method of ['executeMutation', 'recoverPendingMutations', 'inspectStatus']) {
    if (typeof coordinator?.[method] !== 'function') {
      throw new Error(`ExternallyFencedSqliteMutationCoordinatorPort.${method} is required`);
    }
  }
  return coordinator;
}

export function assertAutonomousResearchOnlineAuthorityEvidenceRenewalAdapterPort(adapter) {
  for (const method of ['inspectCurrent', 'renew']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new Error(
        `AutonomousResearchOnlineAuthorityEvidenceRenewalAdapterPort.${method} is required`,
      );
    }
  }
  return adapter;
}

export function assertAutonomousResearchOnlineAuthorityEvidenceControllerPort(controller) {
  for (const method of ['reconcile', 'assertCurrent', 'inspectStatus']) {
    if (typeof controller?.[method] !== 'function') {
      throw new Error(
        `AutonomousResearchOnlineAuthorityEvidenceControllerPort.${method} is required`,
      );
    }
  }
  return controller;
}
