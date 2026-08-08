#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectSourceSupplyChainSecurity,
  writeLocalLockfileSbom,
} from '../verification/source-supply-chain-security.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argumentsSet = new Set(process.argv.slice(2));
const allowed = new Set(['--help', '--require-deployable-templates', '--write-sbom']);
if ([...argumentsSet].some((argument) => !allowed.has(argument))) {
  throw new Error('source_supply_chain_security_argument_invalid');
}
if (argumentsSet.has('--help')) {
  process.stdout.write([
    'Usage: source-supply-chain-security [--write-sbom] [--require-deployable-templates]',
    '',
    'Default: verify tracked-source SAST/secret policy, lockfile SBOM, image identity policy,',
    'and commit-pinned workflow actions without mutating the workspace.',
    '--write-sbom: deterministically refresh the local lockfile CycloneDX inventory before verification.',
    '--require-deployable-templates: fail unless every deployment image is a digest-pinned reference.',
    '',
    'Deployment-template placeholders are accepted only as explicit non-deployable source markers;',
    'they are reported as unpinned and never establish deployment readiness.',
    'The container check is an identity policy, not a registry-backed CVE database scan.',
    'The SBOM is local lockfile inventory, not an external build attestation.',
  ].join('\n'));
  process.exit(0);
}

const writtenSbom = argumentsSet.has('--write-sbom')
  ? writeLocalLockfileSbom({ workspaceRoot })
  : null;
const report = inspectSourceSupplyChainSecurity({
  workspaceRoot,
  requireDeployableTemplates: argumentsSet.has('--require-deployable-templates'),
});
process.stdout.write(`${JSON.stringify({ ...report, writtenSbom }, null, 2)}\n`);
if (report.status !== 'source_supply_chain_security_ready') process.exitCode = 1;
