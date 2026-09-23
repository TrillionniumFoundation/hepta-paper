#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapabilityConformanceProofs, loadCapabilityOperationalProofs } from '../../paper-composition/bootstrap/operator-governance-composition.mjs';
import { validateCapabilityOperationalEvidence } from '../../migration/capability-operational-evidence.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { buildReleaseTrustLayerGate } from '../../paper-domain/governance/release-trust-layer-gate.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeRoot = defaultPaperRuntimeRoot();
const codeProvenance = currentCodeProvenance({
  workspaceRoot,
  allowReleaseCommitEnvironment: false,
});
const releaseCommit = codeProvenance.commit;
const capabilityCount = Object.keys(CAPABILITY_CATALOG).length;
const implementation = validateCapabilityOperationalEvidence({ runtimeRoot, codeProvenance });
const conformance = loadCapabilityConformanceProofs({ runtimeRoot, workspaceRoot, capabilityCatalog: CAPABILITY_CATALOG, releaseCommit, codeProvenance });
const operational = loadCapabilityOperationalProofs({ runtimeRoot, workspaceRoot, capabilityCatalog: CAPABILITY_CATALOG, releaseCommit });
const payload = buildReleaseTrustLayerGate({
  releaseCommit,
  capabilityCount,
  implementationVerified: implementation.size,
  releaseBoundConformanceVerified: conformance.size,
  independentProductionOperationalVerified: operational.size,
});
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (payload.status !== 'code_release_trust_layers_ready') process.exitCode = 1;
