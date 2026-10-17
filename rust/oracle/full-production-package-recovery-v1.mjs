import fs from 'node:fs';
import path from 'node:path';
import { queryFullProductionReadiness } from '../../paper-composition/automation/full-production-readiness-composition.mjs';
import { restrictedChildEnvironment } from '../../paper-adapters/automation/bounded-child-process.mjs';

const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const profile = { node: process.version };
try {
  if (request.action === 'environment') {
    process.stdout.write(JSON.stringify({ profile, result: restrictedChildEnvironment({ source: request.environment }) }));
  } else {
    const publicRoot = path.join(request.root, 'capabilities-public');
    const result = await queryFullProductionReadiness({
      root: request.root,
      runtimeRoot: request.root,
      workspaceRoot: request.root,
      ownerTrustStore: path.join(publicRoot, 'OWNER_TRUST_STORE.json'),
      ownerTrustStoreSha256: request.ownerHash,
      ownerAcceptanceDocument: path.join(publicRoot, 'CAPABILITY_OWNER_ACCEPTANCE.json'),
      ownerAcceptanceDocumentSha256: request.ownerHash,
      ownerReferenceRequiredUid: process.getuid(),
      packageRecoveryReadinessCommand: request.command,
      packageRecoveryReadinessCommandSha256: request.commandHash,
      packageRecoveryReadinessCommandRequiredUid: process.getuid(),
      testOnlyPackageRecoveryReadinessCommandTrustRoot: request.root,
      packageReadinessTimeoutMs: request.timeoutMs ?? 1000,
      environment: request.environment || {},
      clock: { now: () => new Date(request.observedAt || '2026-09-20T00:00:00.000Z') },
      codeProvenanceReader: () => ({ commit: 'a'.repeat(40) }),
      operationalProofLoader: () => new Map(),
      automationReadinessQuery: () => ({ report: {} }),
      offhostWormVerifier: () => ({ kind: 'OffhostWormTargetStatus' }),
    });
    process.stdout.write(JSON.stringify({ profile, result: result.packageRetentionRecoveryInspection }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ profile, error: error.message }));
}
