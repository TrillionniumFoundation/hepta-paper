// Original publisher/reader data-contract fixtures with actual owned V1 intake
// observations. Constructed cycle data is not evidence of an executed cycle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {
  publishAutonomousResearchStrictMachineIntakeReconciliation as publish,
  inspectAutonomousResearchStrictMachineIntakeReconciliation as inspect,
} from '../../paper-adapters/automation/autonomous-research-strict-machine-intake-reconciliation-repository.mjs';
import {inspectAutonomousResearchMachineIntakeStatus}
  from '../../paper-composition/automation/automation-machine-intake-readiness.mjs';

const INNER = 'AutonomousResearchSupervisorMachineIntakeReconciliationReceipt';
const INNER_HASH = 'autonomousResearchSupervisorMachineIntakeReconciliationReceiptHash';
const OUTER = 'AutonomousResearchStrictMachineIntakeReconciliationReceipt';
const OUTER_HASH = 'autonomousResearchStrictMachineIntakeReconciliationReceiptHash';
const CYCLE = 'AutonomousResearchSupervisorCycleReceipt';
const CYCLE_HASH = 'autonomousResearchSupervisorCycleReceiptHash';
const H = name => hashRecord('StrictMachineIntakeDataContractFixture', {name});
const seal = (value, kind, key) => {
  const payload = {...value}; delete payload[key];
  return {...payload, [key]: hashRecord(kind, payload)};
};
function owned(input) {
  const root = path.resolve(input.runtimeRoot);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || fs.realpathSync(root) !== root
    || !root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
    || !fs.existsSync(path.join(root, '.machine-intake-fixture-created'))) {
    throw Error('owned_existing_machine_intake_fixture_required');
  }
  return root;
}
export function runStrictIntakeFixture(input) {
  const runtimeRoot = owned(input);
  const file = path.join(runtimeRoot, 'strict-full-auto-acceptance', 'machine-intake-reconciliation.json');
  let environment = {...input.environment};
  const machineIntake = inspectAutonomousResearchMachineIntakeStatus({runtimeRoot, environment});
  const nowMillis = input.nowMillis ?? Date.now();
  let receipt = null;
  if (input.mode === 'publish') {
    if (machineIntake.coldStartAutonomyReady !== true) throw Error('real_intake_not_ready');
    environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH = H('plan');
    environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY = H('step');
    const scenario = input.scenario || 'ready';
    const reconciliation = seal({version: 1, kind: INNER,
      machineIntakeConfigurationHash: machineIntake.configurationHash,
      topicProducerDatasetSnapshotHash: machineIntake.topicProducerDatasetSnapshotHash,
      machineIntakeCycleResultHash: H('declared-cycle-result'),
      reconciledAt: '2026-01-01T00:00:00.000Z',
      externalSubmissionPerformed: false, automaticBudgetExpansionPerformed: false,
      extraContractField: {includedInActualHash: true},
    }, INNER, INNER_HASH);
    const cycleReceipt = seal({version: 1, kind: CYCLE,
      status: 'autonomous_research_supervisor_cycle_completed',
      machineIntakeReconciliationReceipt: reconciliation,
    }, CYCLE, CYCLE_HASH);
    receipt = structuredClone(publish({runtimeRoot,
      acceptancePlanHash: environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH,
      acceptanceStepIdempotencyKey: environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
      cycleReceipt}));
    if (scenario === 'array-cycle-hash') receipt.cycleReceiptHash = [[receipt.cycleReceiptHash]];
    else if (scenario === 'extra-outer-key') receipt.extra = true;
    else if (scenario === 'tampered-inner') receipt.machineIntakeReconciliationReceipt.extraContractField.includedInActualHash = false;
    else if (scenario === 'missing-nullable') {
      delete receipt.machineIntakeReconciliationReceipt.topicProducerDatasetSnapshotHash;
      receipt.machineIntakeReconciliationReceipt = seal(receipt.machineIntakeReconciliationReceipt, INNER, INNER_HASH);
    } else if (scenario === 'configuration-mismatch') {
      receipt.machineIntakeConfigurationHash = H('wrong-configuration');
      receipt.machineIntakeReconciliationReceipt.machineIntakeConfigurationHash = receipt.machineIntakeConfigurationHash;
      receipt.machineIntakeReconciliationReceipt = seal(receipt.machineIntakeReconciliationReceipt, INNER, INNER_HASH);
    } else if (scenario === 'provider-mismatch') environment.HEPTA_RESEARCH_AUTHOR_MODEL = 'different-actual-provider-model';
    else if (scenario === 'missing-plan') delete environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH;
    else if (scenario === 'wrong-step') environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY = H('wrong-step');
    else if (scenario === 'uppercase-hash') {
      receipt.cycleReceiptHash = receipt.cycleReceiptHash.toUpperCase();
      receipt.machineIntakeReconciliationReceipt.machineIntakeCycleResultHash = receipt.machineIntakeReconciliationReceipt.machineIntakeCycleResultHash.toUpperCase();
      receipt.machineIntakeReconciliationReceipt = seal(receipt.machineIntakeReconciliationReceipt, INNER, INNER_HASH);
    } else if (!['ready', 'numeric-versions', 'null', 'false', 'zero', 'empty-string', 'invalid-json', 'missing-file'].includes(scenario)) {
      throw Error('strict_fixture_scenario_unknown');
    }
    receipt = seal(receipt, OUTER, OUTER_HASH);
    let text = JSON.stringify(receipt) + '\n';
    if (scenario === 'numeric-versions') text = text.replace(/"version":1(?=[,}])/g, '"version":1.0');
    const malformed = {'null': 'null\n', 'false': 'false\n', 'zero': '0\n', 'empty-string': '""\n', 'invalid-json': '{\n'};
    if (Object.hasOwn(malformed, scenario)) text = malformed[scenario];
    fs.writeFileSync(file, text, {mode: 0o600});
    if (scenario === 'missing-file') fs.unlinkSync(file);
  } else if (input.mode !== 'inspect') throw Error('strict_fixture_mode_unknown');
  const actualIntake = inspectAutonomousResearchMachineIntakeStatus({runtimeRoot, environment});
  const expected = inspect({runtimeRoot,
    acceptancePlanHash: environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH,
    acceptanceStepIdempotencyKey: environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
    machineIntake: actualIntake,
    now: new Date(nowMillis),
  });
  return {evidenceScope: 'actual_intake_and_original_receipt_data_contract_not_executed_cycle',
    runtimeRoot, file, environment, nowMillis, machineIntake: actualIntake, receipt, expected};
}
