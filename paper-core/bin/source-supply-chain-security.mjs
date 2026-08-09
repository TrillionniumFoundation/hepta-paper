#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectSourceSupplyChainSecurity,
  writeLocalLockfileSbom,
} from '../verification/source-supply-chain-security.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawArguments = process.argv.slice(2);
const argumentsSet = new Set(rawArguments);
const profileArguments = rawArguments.filter((argument) => argument.startsWith('--deployment-profile='));
const allowed = new Set(['--help', '--require-deployable-templates', '--write-sbom']);
if (argumentsSet.size !== rawArguments.length
  || profileArguments.length > 1
  || rawArguments.some((argument) => !allowed.has(argument)
    && !argument.startsWith('--deployment-profile='))) {
  throw new Error('source_supply_chain_security_argument_invalid');
}
const deploymentProfile = profileArguments.length
  ? profileArguments[0].slice('--deployment-profile='.length)
  : null;
if ((deploymentProfile !== null
    && !['source-inspection', 'systemd-host', 'kubernetes'].includes(deploymentProfile))
  || (deploymentProfile !== null && argumentsSet.has('--require-deployable-templates'))) {
  throw new Error('source_supply_chain_security_argument_invalid');
}
if (argumentsSet.has('--help')) {
  process.stdout.write([
    'Usage: source-supply-chain-security [--write-sbom] [--deployment-profile=PROFILE]',
    '',
    'Default: verify tracked-source SAST/secret policy, lockfile SBOM, image identity policy,',
    'and commit-pinned workflow actions without mutating the workspace.',
    '--write-sbom: deterministically refresh the local lockfile CycloneDX inventory before verification.',
    '--deployment-profile=systemd-host: scope the release check to the sealed host deployment.',
    '--deployment-profile=kubernetes: require every deployment image to be a digest-pinned reference.',
    '--require-deployable-templates: legacy alias for --deployment-profile=kubernetes.',
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
  deploymentProfile,
});
process.stdout.write(`${JSON.stringify({ ...report, writtenSbom }, null, 2)}\n`);
if (report.status !== 'source_supply_chain_security_ready') process.exitCode = 1;
