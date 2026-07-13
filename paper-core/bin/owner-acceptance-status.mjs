#!/usr/bin/env node
import { buildLegacyCapabilityMatrixV3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const matrix = buildLegacyCapabilityMatrixV3({ runtimeRoot: defaultPaperRuntimeRoot() });
process.stdout.write(`${JSON.stringify({
  version: 1,
  kind: 'CapabilityOwnerAcceptanceStatus',
  status: matrix.summary.externallyOwnerAccepted === matrix.summary.entryCount
    ? 'external_independent_owner_acceptance_complete'
    : matrix.summary.localAdminOwnerAccepted === matrix.summary.entryCount
      ? 'local_admin_delegated_owner_acceptance_complete'
      : 'owner_acceptance_pending',
  familyCount: matrix.summary.ownerAcceptanceFamilyCount,
  entryCount: matrix.summary.entryCount,
  ownerAccepted: matrix.summary.ownerAccepted,
  externallyOwnerAccepted: matrix.summary.externallyOwnerAccepted,
  localAdminOwnerAccepted: matrix.summary.localAdminOwnerAccepted,
  ownerAcceptancePending: matrix.summary.ownerAcceptancePending,
  assurance: matrix.summary.externallyOwnerAccepted === matrix.summary.entryCount
    ? 'external_independent'
    : matrix.summary.localAdminOwnerAccepted === matrix.summary.entryCount
      ? 'local_admin_delegated'
      : 'mixed_or_pending',
  independentExternalAcceptanceComplete: matrix.summary.externallyOwnerAccepted === matrix.summary.entryCount,
  externalSignatureRequiredForIndependentAssurance: true,
  automaticAcceptanceForbidden: true,
}, null, 2)}\n`);
