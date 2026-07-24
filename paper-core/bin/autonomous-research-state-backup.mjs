#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeAutonomousResearchStateBackupService,
} from '../../paper-composition/bootstrap/autonomous-research-state-backup-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function usage() {
  return [
    'Usage: autonomous-research-state-backup --action status|backup|restore-drill|renew|reconcile-and-renew [options]',
    '',
    '  status                         Inspect canonical state-database coverage.',
    '  backup                         Create an externally fenced, authority-finalized bundle.',
    '  restore-drill                  Verify a bundle against the live external authority head.',
    '  renew                          Atomically create a backup and drill that exact bundle.',
    '  reconcile-and-renew            Reconcile all online mutation finalizations, then renew.',
    '  --runtime-root PATH            Runtime root to inspect or back up.',
    '  --authority-config PATH        External broker process configuration (required for writes/drills).',
    '  --online-authority-process-config PATH',
    '                                 Pinned online mutation authority process configuration.',
    '  --bundle PATH                  Bundle directory for restore-drill.',
    '',
    'No local flag can replace the signed linearizable authority-head protocol.',
  ].join('\n');
}

async function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['help'],
    valueFlags: [
      'action', 'runtime-root', 'authority-config',
      'online-authority-process-config', 'bundle',
    ],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const action = args.action || 'status';
  if (![
    'status', 'backup', 'restore-drill', 'renew', 'reconcile-and-renew',
  ].includes(action)) {
    throw new Error(`autonomous_research_state_backup_action_invalid:${action}`);
  }
  if (action === 'restore-drill' && !args.bundle) {
    throw new Error('autonomous_research_state_backup_bundle_required');
  }
  if (action === 'reconcile-and-renew'
    && (!args['authority-config'] || !args['online-authority-process-config'])) {
    throw new Error(
      'autonomous_research_state_reconcile_and_renew_authority_configuration_required',
    );
  }
  const service = composeAutonomousResearchStateBackupService({
    workspaceRoot,
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    authorityConfigurationPath: args['authority-config'] || null,
    onlineMutationAuthorityProcessConfigurationPath:
      args['online-authority-process-config'] || null,
  });
  const report = action === 'status'
    ? service.inventory()
    : action === 'backup'
      ? await service.backup()
      : action === 'restore-drill'
        ? await service.restoreDrill({ bundlePath: path.resolve(args.bundle) })
        : action === 'renew'
          ? await service.renew()
          : await service.reconcileAndRenew();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const ready = action === 'status'
    ? report.status === 'autonomous_research_state_database_inventory_ready'
    : action === 'backup'
      ? report.status === 'autonomous_research_state_backup_recorded'
      : action === 'restore-drill'
        ? report.status === 'autonomous_research_state_restore_drill_passed'
        : action === 'renew'
          ? report.status === 'autonomous_research_state_backup_renewal_complete'
          : report.status === 'autonomous_research_state_reconcile_and_renew_complete';
  if (!ready) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
