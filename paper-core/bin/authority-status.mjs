#!/usr/bin/env node
import path from 'node:path';
import { listDirSafe, readJsonIfExists } from '../src/runtime/file-utils.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      args.root = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--json') {
      args.json = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? path.resolve(args.root) : defaultPaperAssetRoot();
  const runtimeRoot = defaultPaperRuntimeRoot();
  const trustStorePath = path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json');
  const trustStore = await readJsonIfExists(trustStorePath);
  const keys = Array.isArray(trustStore?.keys) ? trustStore.keys : [];
  const privateKeyMaterialDetected = keys.some((key) => (
    key?.privateKeyPem || /PRIVATE KEY/.test(String(key?.publicKeyPem || ''))
  ));
  const roleCounts = {};
  for (const key of keys.filter((item) => item?.status === 'active')) {
    for (const role of key.roles || []) roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  const inboxRoot = path.join(runtimeRoot, 'authority-inbox');
  const paperDirectories = (await listDirSafe(inboxRoot)).filter((entry) => entry.isDirectory());
  const inboxes = [];
  for (const entry of paperDirectories) {
    const directory = path.join(inboxRoot, entry.name);
    inboxes.push({
      paperId: entry.name,
      independentRefereeVerdictPresent: Boolean(
        await readJsonIfExists(path.join(directory, 'INDEPENDENT_REFEREE_VERDICT.json')),
      ),
      liveSubmissionAuthorizationPresent: Boolean(
        await readJsonIfExists(path.join(directory, 'LIVE_SUBMISSION_AUTHORIZATION.json')),
      ),
    });
  }
  const requiredRoleCounts = {
    academic_evidence_authority: 1,
    independent_referee: 1,
    submission_operator: 1,
    live_executor_authorizer: 1,
  };
  const missingRoles = Object.entries(requiredRoleCounts)
    .filter(([role, minimum]) => Number(roleCounts[role] || 0) < minimum)
    .map(([role]) => role);
  const report = {
    version: 1,
    kind: 'AuthorityPipelineStatus',
    status: missingRoles.length || privateKeyMaterialDetected
      ? 'authority_pipeline_trust_not_ready'
      : 'authority_pipeline_trust_ready',
    trustStorePath: path.relative(root, trustStorePath).replace(/\\/g, '/'),
    trustStorePresent: Boolean(trustStore),
    activeKeyCount: keys.filter((item) => item?.status === 'active').length,
    roleCounts,
    missingRoles,
    privateKeyMaterialDetected,
    authorityInboxCount: inboxes.length,
    inboxes,
    safety: {
      readsOnly: true,
      privateKeysPersistedInTrustStoreAllowed: false,
      externalActionPerformed: false,
    },
  };
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : [
    `status: ${report.status}`,
    `trust_store: ${report.trustStorePresent ? 'present' : 'missing'}`,
    `active_keys: ${report.activeKeyCount}`,
    `missing_roles: ${report.missingRoles.join(',') || 'none'}`,
    `authority_inboxes: ${report.authorityInboxCount}`,
    '',
  ].join('\n'));
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
