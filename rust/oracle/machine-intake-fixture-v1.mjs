// Test-only owned filesystem fixture. Every expected result comes from incumbent
// builders, repositories, and the actual readonly machine-intake inspector.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
  verifyAutonomousResearchRecurringGoldenTemplate,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeConfiguration,
  verifyAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  inspectAutonomousResearchMachineIntakeStatus,
} from '../../paper-composition/automation/automation-machine-intake-readiness.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  inspectAutonomousResearchProfileResourceBudgetClosure,
} from '../../paper-domain/automation/autonomous-research-resource-budget-policy.mjs';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {createAutonomousResearchSupervisorInstanceRepository} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';

const H = text => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const ADMITTED = '2026-01-01T00:00:00.000Z';
const BUDGETS = {maxWallTimeMs: 3600000, maxAgentCalls: 24, maxCpuJobs: 32,
  maxGpuJobs: 0, maxTokenCount: 100000, maxCostUsd: 25, maxMemoryMiB: 4096};
const FAMILIES = ['rl_stochastic_control_benchmark', 'ml_algorithm_benchmark',
  'econometrics_panel_benchmark', 'finance_asset_pricing_benchmark',
  'operations_optimization_benchmark'];
function ownedRoot(requested) {
  const root = path.resolve(requested);
  const temporary = fs.realpathSync(os.tmpdir());
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || fs.realpathSync(root) !== root || !root.startsWith(temporary + path.sep)
    || (stat.mode & 0o077) !== 0) throw Error('owned_machine_intake_fixture_root_required');
  return root;
}
function writeJson(candidate, value) {
  fs.writeFileSync(candidate, JSON.stringify(value) + '\n', {mode: 0o600});
  fs.chmodSync(candidate, 0o600);
}
function rehash(value, domain, key) {
  const {[key]: _old, ...payload} = value;
  return {...payload, [key]: hashRecord(domain, payload)};
}
function provider() {
  return resolveAutonomousResearchProviderConfiguration({environment: {}});
}
function dataset(label, family) {
  return {name: 'dataset-' + label, source: '/datasets/' + label, readOnly: true,
    manifestHash: H('dataset-' + label), licenseId: 'CC0-1.0', benchmarkFamily: family};
}
function oneShot(label, providerHash, overrides = {}) {
  const family = overrides.protocolFamily || 'ml_algorithm_benchmark';
  return buildAutonomousResearchMachineIntake({
    intakeId: 'intake:' + label, paperId: 'paper:' + label,
    campaignId: 'autonomous-research:paper:' + label, launchMode: 'production-run',
    objective: 'Evaluate the bounded ' + label + ' empirical objective.',
    protocolFamily: family, datasetMounts: [dataset(label, family)], budgets: BUDGETS,
    providerConfigurationHash: providerHash, revisionRounds: 1, refereeCount: 2,
    admissionCreatedAt: ADMITTED, recurringGoldenProvenance: null, ...overrides,
  });
}
function golden(providerHash, overrides = {}) {
  const family = overrides.protocolFamily || 'ml_algorithm_benchmark';
  return buildAutonomousResearchRecurringGoldenTemplate({
    templateId: 'golden-fixture', epochDurationMs: 43200000,
    objective: 'Continuously evaluate the bounded scientific campaign.',
    protocolFamily: family, datasetMounts: [dataset('golden', family)], budgets: {},
    providerConfigurationHash: providerHash, revisionRounds: 1, refereeCount: 2, ...overrides,
  });
}
function inspection(root, environment) {
  return inspectAutonomousResearchMachineIntakeStatus({runtimeRoot: root, environment});
}
function databasePath(root) {
  return path.join(root, 'autonomous-research', 'machine-intake', 'machine-intake.sqlite');
}
function mutateDatabase(root, operation) {
  const db = new DatabaseSync(databasePath(root));
  try { operation(db); } finally { db.close(); }
}
function append(repository, intake, configuration, root, sourceKind = 'static-file', template = null, at = ADMITTED) {
  return repository.appendIntake({
    intake, sourceKind, sourceAuthorityHash: configuration.configurationHash,
    sourceRef: sourceKind === 'machine' ? 'machine-api'
      : sourceKind === 'recurring-golden'
        ? template.templateId + '@' + intake.recurringGoldenProvenance.epochStart
        : path.join(root, 'static.json'),
    sourceTemplate: template, now: new Date(at),
  });
}
function setup(input) {
  const root = ownedRoot(input.runtimeRoot);
  fs.writeFileSync(path.join(root, '.machine-intake-fixture-created'), 'owned fixture\n', {flag: 'wx', mode: 0o600});
  const scenario = input.scenario || 'ready';
  const configurationPath = path.join(root, 'configuration.json');
  const staticPath = path.join(root, 'static.json');
  const providerConfiguration = provider();
  const providerHash = providerConfiguration.autonomousResearchProviderConfigurationHash;
  const upper = H('ordinary-optional-document').toUpperCase();
  const optionalMount = {...dataset('optional', 'ml_algorithm_benchmark'),
    manifestHash: upper, licenseId: 'LicenseRef-OwnedFixture',
    operatorAuthorizationHash: upper, operatorDatasetAuthorityDocumentHash: upper,
    operatorDatasetAuthority: {version: 1, kind: 'OrdinaryFixtureData'},
    operatorDatasetResearchSemantics: {fixture: true}, operatorDatasetResearchSemanticsHash: upper,
    operatorDatasetHarnessHandle: upper, splitManifestHash: upper,
    benchmarkHarnessDocumentHash: upper, benchmarkHarnessDefinitionHash: upper,
    analysisProtocol: {fixture: true}, analysisProtocolHash: upper,
    benchmarkSeedSchedule: [-2, 0, 17, 9007199254740991], benchmarkMinimumRepetitions: -2};
  const overrides = scenario === 'optional-mounts' ? {datasetMounts: [optionalMount]} : {};
  const staticIntake = oneShot('static', providerHash, overrides);
  const template = golden(providerHash, overrides);
  writeJson(staticPath, staticIntake);
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{path: staticPath, intakeHash: staticIntake.intakeHash}],
    recurringGoldenTemplates: [template], machineAppendEnabled: false,
  });
  writeJson(configurationPath, configuration);
  const environment = {HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configurationPath};
  if (scenario !== 'missing-state') {
    const repository = createAutonomousResearchMachineIntakeRepository({
      runtimeRoot: root, authorizedSourceAuthorityHash: configuration.configurationHash,
      create: true, offlineProvision: true,
    });
    try {
      append(repository, staticIntake, configuration, root);
      if (scenario === 'ordered-pending') {
        // All dates are historical and stable across the two actual inspector calls.
        // The actual original append/lease APIs produce durable rows, admissions and lease.
        for (const label of ['machine-b', 'machine-a', 'future', 'enqueued', 'invalid']) {
          const intake = oneShot(label, providerHash);
          append(repository, intake, configuration, root, 'machine');
        }
        for (const [label, at] of [['first', ADMITTED], ['second', '2026-01-01T12:00:00.000Z']]) {
          const selected = golden(providerHash, {templateId: 'golden-' + label});
          const intake = materializeAutonomousResearchRecurringGoldenIntake({
            template: selected, now: new Date(at), sourceAuthorityHash: configuration.configurationHash,
          });
          append(repository, intake, configuration, root, 'recurring-golden', selected, at);
        }
        const lease = repository.tryAcquireIntakeLease({
          intakeId: staticIntake.intakeId, ownerId: 'fixture-worker', leaseMs: 1000,
          now: new Date(ADMITTED),
        });
        if (!lease) throw Error('fixture_original_lease_not_created');
      }
    } finally { repository.close(); }
  }
  if (scenario === 'static-drift') {
    writeJson(staticPath, oneShot('static', providerHash, {objective: 'A different valid empirical objective.'}));
  } else if (scenario === 'provider-mismatch') {
    environment.HEPTA_RESEARCH_AUTHOR_MODEL = 'different-actual-model';
  } else if (scenario === 'db-binding-mismatch') {
    mutateDatabase(root, db => db.prepare('UPDATE autonomous_research_machine_intake_metadata SET configured_source_authority_hash=? WHERE singleton=1').run(H('different-source-authority')));
  } else if (scenario === 'tampered-intake') {
    mutateDatabase(root, db => {
      const row = db.prepare('SELECT intake_json FROM autonomous_research_machine_intake WHERE intake_id=?').get(staticIntake.intakeId);
      const intake = JSON.parse(row.intake_json); intake.objective = 'Tampered durable empirical objective.';
      db.prepare('UPDATE autonomous_research_machine_intake SET intake_json=? WHERE intake_id=?').run(JSON.stringify(intake), staticIntake.intakeId);
    });
  } else if (scenario === 'tampered-admission') {
    mutateDatabase(root, db => {
      const row = db.prepare('SELECT admission_json FROM autonomous_research_machine_intake WHERE intake_id=?').get(staticIntake.intakeId);
      const admission = JSON.parse(row.admission_json); admission.sourceKind = 'machine';
      db.prepare('UPDATE autonomous_research_machine_intake SET admission_json=? WHERE intake_id=?').run(JSON.stringify(admission), staticIntake.intakeId);
    });
  } else if (scenario === 'ordered-pending') {
    mutateDatabase(root, db => {
      db.prepare('UPDATE autonomous_research_machine_intake SET next_attempt_at=? WHERE intake_id=?')
        .run('2100-01-01T00:00:00.000Z', 'intake:future');
      db.prepare("UPDATE autonomous_research_machine_intake SET disposition='enqueued',enqueued_at=? WHERE intake_id=?").run(ADMITTED, 'intake:enqueued');
      db.prepare("UPDATE autonomous_research_machine_intake SET disposition='invalid',invalid_reason='fixture-invalid' WHERE intake_id=?").run('intake:invalid');
      db.prepare('UPDATE autonomous_research_machine_intake SET next_attempt_at=?,failure_count=2,last_error=? WHERE intake_id=?')
        .run('2026-01-01T00:00:01.000Z', 'fixture-backoff', 'intake:machine-a');
    });
  } else if (scenario === 'numeric-versions') {
    for (const candidate of [staticPath, configurationPath]) {
      const bytes = fs.readFileSync(candidate, 'utf8').replace(/"version":([12])(?=[,}])/g, '"version":$1.0');
      fs.writeFileSync(candidate, bytes);
    }
    mutateDatabase(root, db => {
      const row = db.prepare('SELECT intake_json,admission_json FROM autonomous_research_machine_intake WHERE intake_id=?').get(staticIntake.intakeId);
      db.prepare('UPDATE autonomous_research_machine_intake SET intake_json=?,admission_json=? WHERE intake_id=?').run(
        row.intake_json.replace(/"version":2(?=[,}])/g, '"version":2.0'),
        row.admission_json.replace(/"version":1(?=[,}])/g, '"version":1.0'), staticIntake.intakeId);
    });
  } else if (!['ready', 'missing-state', 'optional-mounts'].includes(scenario)) {
    throw Error('machine_intake_fixture_scenario_unknown');
  }
  const nowMillis = Date.now();
  return {runtimeRoot: root, environment, nowMillis, configuration, staticIntake, template,
    providerConfiguration, expected: inspection(root, environment)};
}
function budgetMatrix(input) {
  const root = ownedRoot(input.runtimeRoot);
  fs.writeFileSync(path.join(root, '.machine-intake-fixture-created'), 'owned matrix\n', {flag: 'wx', mode: 0o600});
  const providerHash = provider().autonomousResearchProviderConfigurationHash;
  const cases = [];
  function add(label, templates, templateValid = null) {
    const configuration = rehash({
      version: 1, kind: 'AutonomousResearchMachineIntakeConfiguration',
      staticIntakeFiles: [], recurringGoldenTemplates: templates, machineAppendEnabled: false,
    }, 'AutonomousResearchMachineIntakeConfiguration', 'configurationHash');
    const candidate = path.join(root, 'case-' + cases.length + '.json');
    writeJson(candidate, configuration);
    const environment = {HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: candidate};
    cases.push({label, environment, templateValid,
      configurationValid: verifyAutonomousResearchMachineIntakeConfiguration(configuration),
      expected: inspection(root, environment)});
  }
  for (const family of FAMILIES) {
    const profile = autonomousEmpiricalFamilyPluginProfileFor(family);
    const base = golden(providerHash, {protocolFamily: family});
    for (let rounds = 1; rounds <= 10; rounds++) {
      for (let reviewers = 2; reviewers <= 7; reviewers++) {
        const resource = inspectAutonomousResearchProfileResourceBudgetClosure({
          campaignId: 'autonomous-research:golden-template:golden-fixture',
          revisionRounds: rounds, refereeCount: reviewers, executionProfile: profile.executionProfile,
          benchmarkSelector: {selectorType: 'authorized_dataset_mount',
            experimentDesign: {seedSchedule: profile.seedSchedule, minimumRepetitions: profile.minimumRepetitions}},
          budgets: base.budgets,
        });
        let candidate;
        try {
          candidate = golden(providerHash, {protocolFamily: family, revisionRounds: rounds, refereeCount: reviewers});
        } catch {
          // A candidate over the hard agent ceiling is deliberately INVALID.
          // The original verifier, not this construction, supplies its expected result.
          candidate = rehash({...base, revisionRounds: rounds, refereeCount: reviewers,
            budgets: {...base.budgets, maxAgentCalls: 512, maxCpuJobs: 32768}},
          'AutonomousResearchRecurringGoldenTemplate', 'templateHash');
        }
        add(family + ':' + rounds + ':' + reviewers, [candidate],
          verifyAutonomousResearchRecurringGoldenTemplate(candidate));
        if (rounds === 1 && reviewers === 2) {
          for (const key of ['maxAgentCalls', 'maxCpuJobs']) {
            const below = rehash({...candidate, budgets: {...candidate.budgets,
              [key]: resource.requiredBudgets[key] - 1}},
            'AutonomousResearchRecurringGoldenTemplate', 'templateHash');
            add(family + ':below-' + key, [below], verifyAutonomousResearchRecurringGoldenTemplate(below));
          }
        }
      }
    }
  }
  const template = golden(providerHash, {budgets: {maxAgentCalls: 288}});
  const other = golden(providerHash, {templateId: 'another', budgets: {maxAgentCalls: 288}});
  add('daily-agent-exact', [template, other], true);
  const over = rehash({...other, budgets: {...other.budgets, maxAgentCalls: 289}},
    'AutonomousResearchRecurringGoldenTemplate', 'templateHash');
  add('daily-agent-over', [template, over], true);
  add('duplicate-template', [template, template], true);
  return {runtimeRoot: root, nowMillis: Date.now(), cases};
}
export function runMachineIntakeFixture(input) {
  if (input.mode === 'setup') return setup(input);
  if (input.mode === 'resident') {
    const root = ownedRoot(input.runtimeRoot);
    if (!fs.existsSync(path.join(root, '.machine-intake-fixture-created'))) throw Error('fixture_not_created');
    const repository = createAutonomousResearchSupervisorInstanceRepository({runtimeRoot: root});
    try {
      const now = new Date();
      const lease = repository.acquireInstanceLease({ownerId: 'intake-health-fixture', leaseMs: 900000, heartbeatMs: 30000, now});
      if (!lease) throw Error('fixture_resident_lease_required');
      repository.markStartupReconciled({lease, receiptHash: H('startup'), now});
      repository.markMachineIntakeReconciled({lease, receiptHash: H('intake'), configurationHash: input.configurationHash, now});
    } finally { repository.close(); }
    return {ready: true};
  }
  if (input.mode === 'budget-matrix') return budgetMatrix(input);
  if (input.mode === 'inspect') {
    const root = ownedRoot(input.runtimeRoot);
    return {runtimeRoot: root, environment: input.environment,
      nowMillis: Date.now(), expected: inspection(root, input.environment)};
  }
  throw Error('machine_intake_fixture_mode_unknown');
}

