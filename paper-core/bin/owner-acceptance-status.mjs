#!/usr/bin/env node
import { buildLegacyCapabilityMatrixV3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const matrix = buildLegacyCapabilityMatrixV3({ runtimeRoot: defaultPaperRuntimeRoot() });
process.stdout.write(`${JSON.stringify({
  version: 1,
  kind: 'CapabilityOwnerAcceptanceStatus',
  status: matrix.summary.ownerAccepted === matrix.summary.entryCount
    ? 'owner_acceptance_complete'
    : 'owner_acceptance_pending',
  familyCount: matrix.summary.ownerAcceptanceFamilyCount,
  entryCount: matrix.summary.entryCount,
  ownerAccepted: matrix.summary.ownerAccepted,
  ownerAcceptancePending: matrix.summary.ownerAcceptancePending,
  externalSignatureRequired: true,
  automaticAcceptanceForbidden: true,
}, null, 2)}\n`);
