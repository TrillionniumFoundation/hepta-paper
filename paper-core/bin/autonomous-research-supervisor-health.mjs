#!/usr/bin/env node
import path from 'node:path';

import {
  queryAutonomousResearchSupervisorInstanceStatus,
  queryStrictMachineIntakeReconciliation,
} from '../../paper-composition/automation/autonomous-research-supervisor-state-composition.mjs';
import {
  inspectAutonomousResearchMachineIntakeStatus,
} from '../../paper-composition/automation/automation-machine-intake-readiness.mjs';
import {
  inspectAutonomousResearchResidentPrerequisites,
} from '../../paper-composition/automation/autonomous-research-resident-prerequisite-inspection.mjs';
import {
  inspectAutonomousResearchStateSafety,
} from '../../paper-composition/automation/autonomous-research-state-safety-inspection.mjs';
import {
  defaultPaperRuntimeRoot,
  HEPTA_WORKSPACE_ROOT,
} from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: [
    'help',
    'require-startup-reconciliation',
    'require-machine-intake-reconciliation',
    'require-current-machine-intake',
    'require-strict-machine-intake-reconciliation',
    'require-fully-autonomous',
  ],
  valueFlags: ['external-qualification-config', 'runtime-root'],
  positional: false,
});

if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchSupervisorHealthUsage',
    usage: 'autonomous-research-supervisor-health --runtime-root PATH [--require-startup-reconciliation|--require-machine-intake-reconciliation|--require-current-machine-intake|--require-fully-autonomous]',
    mutation: 'none',
  }, null, 2)}\n`);
} else {
  const runtimeRoot = path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot());
  const now = new Date();
  const status = queryAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now,
  });
  const machineIntake = (args['require-current-machine-intake']
      || args['require-strict-machine-intake-reconciliation']
      || args['require-fully-autonomous'])
    ? inspectAutonomousResearchMachineIntakeStatus({ runtimeRoot, environment: process.env })
    : null;
  const residentPrerequisites = args['require-fully-autonomous']
    ? inspectAutonomousResearchResidentPrerequisites({
      runtimeRoot,
      environment: process.env,
      externalQualificationConfigPath: args['external-qualification-config'] || null,
      now,
    }) : null;
  let autonomousStateSafety = null;
  if (args['require-fully-autonomous']) {
    try {
      autonomousStateSafety = inspectAutonomousResearchStateSafety({
        workspaceRoot: HEPTA_WORKSPACE_ROOT,
        runtimeRoot,
        now,
        environment: process.env,
      });
    } catch {
      autonomousStateSafety = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchStateSafetyInspectionUnavailable',
        status: 'autonomous_research_state_safety_blocked',
        ready: false,
        blockers: Object.freeze([
          'autonomous_research_state_safety_inspection_failed',
        ]),
      });
    }
  }
  const currentDatasetSnapshotHash =
    machineIntake?.topicProducerDatasetSnapshotHash || null;
  const reconciledDatasetSnapshotHash =
    status.instance?.machineIntakeDatasetSnapshotHash || null;
  const currentMachineIntakeReady = Boolean(machineIntake?.coldStartAutonomyReady
    && status.ready
    && machineIntake.configurationHash
      === status.instance?.machineIntakeConfigurationHash
    && currentDatasetSnapshotHash === reconciledDatasetSnapshotHash);
  const residentPrerequisiteIdentityCurrent = Boolean(residentPrerequisites?.ready
    && residentPrerequisites.autonomousResearchResidentPrerequisiteIdentityHash
      === status.instance?.fullyAutonomousPrerequisiteIdentityHash);
  const fullyAutonomousReady = Boolean(currentMachineIntakeReady
    && status.fullyAutonomousPrerequisitesReady
    && residentPrerequisiteIdentityCurrent
    && autonomousStateSafety?.ready === true);
  const strictMachineIntakeReconciliation =
    args['require-strict-machine-intake-reconciliation']
      ? queryStrictMachineIntakeReconciliation({
        runtimeRoot,
        acceptancePlanHash:
          process.env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH,
        acceptanceStepIdempotencyKey:
          process.env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
        machineIntake,
        now,
      }) : null;
  const report = machineIntake ? Object.freeze({
    ...status,
    currentMachineIntakeReady,
    currentMachineIntakeConfigurationHash: machineIntake.configurationHash,
    currentTopicProducerDatasetSnapshotHash: currentDatasetSnapshotHash,
    reconciledTopicProducerDatasetSnapshotHash: reconciledDatasetSnapshotHash,
    residentPrerequisites,
    residentPrerequisiteIdentityCurrent,
    autonomousStateSafety,
    autonomousStateSafetyReady: autonomousStateSafety?.ready === true,
    autonomousStateSafetyBlockers: autonomousStateSafety?.blockers || [],
    fullyAutonomousReady,
    strictMachineIntakeReconciliation,
    strictMachineIntakeReconciliationReady:
      strictMachineIntakeReconciliation?.ready === true,
    currentMachineIntakeBlockers: machineIntake.blockers,
  }) : status;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  const passing = args['require-fully-autonomous'] ? fullyAutonomousReady
    : args['require-strict-machine-intake-reconciliation']
      ? strictMachineIntakeReconciliation?.ready === true
      : args['require-current-machine-intake']
        ? currentMachineIntakeReady
        : args['require-machine-intake-reconciliation'] ? status.ready
          : args['require-startup-reconciliation'] ? status.startupReady : status.healthy;
  process.exitCode = passing ? 0 : 2;
}
