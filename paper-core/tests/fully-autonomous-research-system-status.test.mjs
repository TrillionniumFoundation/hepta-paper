import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  inspectAutonomousResearchTopicProducerImplementationIdentity,
  readAutonomousResearchTopicProducerProfile,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import {
  createAutonomousResearchTopicProducerRepository,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-repository.mjs';
import {
  inspectStrictDatasetManifest,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  buildAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  selectMachineGeneratedAutonomousResearchAgenda,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  buildResearchAgendaIr,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  buildConservativePriorArtClaimAlignment,
} from '../../paper-application/automation/prior-art-claim-alignment-production.mjs';
import {
  inspectPersistedAutonomousResearchAgendaAuthority,
} from '../../paper-composition/automation/automation-readiness-agenda-authority-inspection.mjs';
import {
  genericManuscriptReleaseFixture,
  productionPriorArtAuthorityFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  installMachineIntakeExternalGenesisAuthority,
} from './machine-intake-external-authority-test-support.mjs';

const AUTHORITY_STATE_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority.mjs',
  import.meta.url,
);
const AUTHORIZATION_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
const AUTHORIZATION_DOUBLE = new URL(
  './test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (context.parentURL?.split('?')[0] === AUTHORITY_STATE_MODULE.href
      && resolved.url === AUTHORIZATION_MODULE.href) {
      return { shortCircuit: true, url: AUTHORIZATION_DOUBLE.href };
    }
    return resolved;
  },
});
const {
  evaluateFullyAutonomousResearchSystemReadiness,
  inspectAutonomousResearchMachineIntakeStatus,
  inspectAutonomousResearchSupervisorInstanceStatus,
} = await import('../../paper-composition/automation/automation-readiness-query.mjs');
const { createAutonomousResearchMachineIntakeRepository } = await import(
  '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs'
);

const H = (label) => hashRecord('FullyAutonomousResearchSystemStatusTestHash', { label });
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PROVIDER_CONFIGURATION = resolveAutonomousResearchProviderConfiguration({ environment: {} });
const PROVIDER_CONFIGURATION_HASH =
  PROVIDER_CONFIGURATION.autonomousResearchProviderConfigurationHash;
const BUDGETS = Object.freeze({
  maxWallTimeMs: 60 * 60 * 1000,
  maxAgentCalls: 24,
  maxCpuJobs: 32,
  maxGpuJobs: 0,
  maxTokenCount: 100_000,
  maxCostUsd: 25,
  maxMemoryMiB: 4096,
});

function datasetMount(label) {
  return Object.freeze({
    name: `benchmark-${label}`,
    source: `/datasets/benchmark-${label}`,
    readOnly: true,
    manifestHash: H(`dataset:${label}`),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  });
}

function recurringTemplate({
  objective = 'Continuously qualify the bounded unattended research system.',
} = {}) {
  return buildAutonomousResearchRecurringGoldenTemplate({
    templateId: 'system-cold-start',
    epochDurationMs: 12 * 60 * 60 * 1000,
    objective,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [datasetMount('golden')],
    providerConfigurationHash: PROVIDER_CONFIGURATION_HASH,
    revisionRounds: 1,
    refereeCount: 2,
  });
}

function productionIntake() {
  return buildAutonomousResearchMachineIntake({
    intakeId: 'intake:status-production',
    paperId: 'paper:status-production',
    campaignId: 'autonomous-research:paper:status-production',
    launchMode: 'production-run',
    admissionCreatedAt: '2026-07-16T00:00:00.000Z',
    objective: 'Evaluate the bounded production intake status objective.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [datasetMount('production')],
    budgets: BUDGETS,
    providerConfigurationHash: PROVIDER_CONFIGURATION_HASH,
    recurringGoldenProvenance: null,
    revisionRounds: 2,
    refereeCount: 3,
  });
}

function topicProducerProfile({
  datasetSource,
  producerId = 'system-status-topic-producer',
  implementationSha256 = inspectAutonomousResearchTopicProducerImplementationIdentity()
    .implementationSha256,
} = {}) {
  const observedManifestHash = (() => {
    if (!datasetSource || !path.isAbsolute(datasetSource) || !fs.existsSync(datasetSource)) {
      return H('dataset:topic-producer');
    }
    const inspection = inspectStrictDatasetManifest(
      datasetSource,
      path.dirname(datasetSource),
    );
    return inspection.hash || H('dataset:topic-producer:invalid');
  })();
  return buildAutonomousResearchTopicProducerProfile({
    producerId,
    implementationSha256,
    providerConfigurationHash: PROVIDER_CONFIGURATION_HASH,
    minimumGenerationIntervalMs: 60 * 60 * 1000,
    maximumTopicsPerUtcDay: 12,
    maximumProviderCanaryAttemptsPerUtcDay: 24,
    maximumProviderCanaryCostUsdPerUtcDay: 24,
    registeredResearchProfiles: [{
      profileId: 'system-status-registered-replication',
      objective: 'Evaluate the registered bounded status benchmark replication.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts: [{
        ...datasetMount('topic-producer'),
        source: datasetSource,
        manifestHash: observedManifestHash,
      }],
      budgets: BUDGETS,
      revisionRounds: 2,
      refereeCount: 2,
    }],
  });
}

function writeJson(candidate, value) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(candidate, 0o600);
}

function fileTree(root) {
  if (!fs.existsSync(root)) return Object.freeze([]);
  const entries = [];
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    entries.push(Object.freeze({
      path: path.relative(root, candidate) || '.',
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }));
    if (stat.isDirectory()) {
      fs.readdirSync(candidate).sort().forEach((name) => visit(path.join(candidate, name)));
    }
  };
  visit(root);
  return Object.freeze(entries);
}

test('configured scope remains bounded until generic domain evidence is independently verified', () => {
  const configurationHash = H('fully-autonomous-current-configuration');
  const datasetSnapshotHash = H('fully-autonomous-dataset-snapshot');
  const prerequisiteIdentityHash = H('fully-autonomous-prerequisite-identity');
  const coldReady = {
    coldStartAutonomyReady: true,
    configurationHash,
    topicProducerDatasetSnapshotHash: datasetSnapshotHash,
    blockers: [],
  };
  const residentHealthy = {
    healthy: true,
    ready: true,
    instance: {
      machineIntakeConfigurationHash: configurationHash,
      machineIntakeDatasetSnapshotHash: datasetSnapshotHash,
      fullyAutonomousPrerequisiteIdentityHash: prerequisiteIdentityHash,
    },
    blockers: [],
  };
  const residentPrerequisites = {
    ready: true,
    autonomousResearchResidentPrerequisiteIdentityHash: prerequisiteIdentityHash,
    blockers: [],
  };
  const autonomousStateSafety = { ready: true, blockers: [] };
  const capabilityScopeInspection = {
    authorIdentityAttestationReady: true,
    blockers: [],
  };
  const capabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: ['ml_algorithm_benchmark'],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 3,
    reviewerTrustDomainCount: 3,
    replayMode: 'external-trust-domain-v1',
    venueMode: 'submission-enabled-v1',
    externalPrerequisites: [],
  });
  const agendaRequest = buildAutonomousResearchAgendaProductionRequest({
    paperId: 'fully-autonomous-status-paper',
    objectiveHint: 'Evaluate a bounded generated intervention.',
    protocolFamilyHint: 'ml_algorithm_benchmark',
    allowedProtocolFamilies: ['ml_algorithm_benchmark'],
  });
  const agendaAgentPayload = {
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    agentId: 'agenda-producer-1',
    providerMode: 'fixture-agent',
    resolvedModel: 'agenda-model-v1',
    promptHash: H('agenda-prompt'),
    changedPaths: [],
    structuredOutput: {},
  };
  const agendaAgentReceipt = Object.freeze({
    ...agendaAgentPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', agendaAgentPayload),
  });
  const researchAgendaProducerReceipt = buildAutonomousResearchAgendaProductionReceipt({
    request: agendaRequest,
    selectedObjective: 'Measure a generated treatment against a fixed benchmark control.',
    selectedProtocolFamily: 'ml_algorithm_benchmark',
    agentExecutionReceipt: agendaAgentReceipt,
    producerId: 'agenda-producer-1',
    generatedAt: '2026-07-19T00:00:00.000Z',
  });
  assert.equal(evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: false,
    machineIntake: coldReady,
    residentSupervisor: residentHealthy,
    residentPrerequisites,
    autonomousStateSafety,
  }).ready, false);
  assert.equal(evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: true,
    machineIntake: { coldStartAutonomyReady: false, blockers: ['intake_missing'] },
    residentSupervisor: residentHealthy,
    residentPrerequisites,
    autonomousStateSafety,
  }).ready, false);
  const noResident = evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: true,
    machineIntake: coldReady,
    residentPrerequisites,
    autonomousStateSafety,
  });
  assert.equal(noResident.ready, false);
  assert.match(noResident.blockers.join(','), /supervisor_instance_health_required/);
  const missingAgendaReceipt = evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: true,
    machineIntake: coldReady,
    residentSupervisor: residentHealthy,
    residentPrerequisites,
    autonomousStateSafety,
    capabilityScopeManifest,
  });
  assert.equal(missingAgendaReceipt.ready, false);
  assert.match(missingAgendaReceipt.blockers.join(','), /machine_generated_agenda_receipt_required/);
  const configured = evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: true,
    machineIntake: coldReady,
    residentSupervisor: residentHealthy,
    residentPrerequisites,
    autonomousStateSafety,
    capabilityScopeManifest,
    capabilityScopeInspection,
    researchAgendaProducerReceipt,
  });
  assert.equal(configured.ready, false);
  assert.equal(configured.boundedProfileReady, true);
  assert.equal(configured.configuredScopeReady, true);
  assert.equal(configured.genericDomainCapabilityReady, false);
  assert.equal(configured.status, 'bounded_profile_autonomous_research_system_ready');
  assert.ok(configured.blockers.includes(
    'autonomous_research_experiment_ir_execution_authority_receipt_required',
  ));
  assert.ok(configured.blockers.includes(
    'autonomous_research_external_research_replay_receipt_required',
  ));
  assert.ok(configured.blockers.includes(
    'autonomous_research_independent_formal_review_receipt_required',
  ));
  assert.equal(configured.machineIntakeConfigurationReconciled, true);
  const missingCapabilityInspection =
    evaluateFullyAutonomousResearchSystemReadiness({
      fullAutomaticResearchWritingReady: true,
      machineIntake: coldReady,
      residentSupervisor: residentHealthy,
      residentPrerequisites,
      autonomousStateSafety,
      capabilityScopeManifest,
      researchAgendaProducerReceipt,
    });
  assert.equal(missingCapabilityInspection.configuredScopeReady, false);
  assert.ok(missingCapabilityInspection.blockers.includes(
    'autonomous_research_author_identity_attestation_required',
  ));
  const missingStateSafety = evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: true,
    machineIntake: coldReady,
    residentSupervisor: residentHealthy,
    residentPrerequisites,
  });
  assert.equal(missingStateSafety.ready, false);
  assert.match(missingStateSafety.blockers.join(','), /state_safety_inspection_required/);
  const staleResident = evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: true,
    machineIntake: coldReady,
    residentSupervisor: {
      ...residentHealthy,
      instance: {
        ...residentHealthy.instance,
        machineIntakeConfigurationHash: H('stale-resident-configuration'),
      },
    },
    residentPrerequisites,
    autonomousStateSafety,
  });
  assert.equal(staleResident.ready, false);
  assert.match(staleResident.blockers.join(','), /machine_intake_configuration_mismatch/);
});

test('persisted agenda authority promotes only a hash-bound, machine-generated campaign receipt', () => {
  const manifest = buildAutonomousResearchCapabilityScopeManifest({
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: ['ml_algorithm_benchmark'],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 3,
    reviewerTrustDomainCount: 3,
    replayMode: 'external-trust-domain-v1',
    venueMode: 'submission-enabled-v1',
    externalPrerequisites: [],
  });
  const request = buildAutonomousResearchAgendaProductionRequest({
    paperId: 'agenda-authority-paper',
    objectiveHint: 'Select a machine-generated research objective.',
    protocolFamilyHint: 'ml_algorithm_benchmark',
    allowedProtocolFamilies: ['ml_algorithm_benchmark'],
  });
  const agentPayload = {
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    agentId: 'agenda-authority-producer',
    providerMode: 'fixture-agent',
    resolvedModel: 'agenda-model-v1',
    promptHash: H('agenda-authority-prompt'),
    changedPaths: [],
    structuredOutput: {},
  };
  const agentExecutionReceipt = Object.freeze({
    ...agentPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', agentPayload),
  });
  const receipt = buildAutonomousResearchAgendaProductionReceipt({
    request,
    selectedObjective: 'Compare a generated intervention with a fixed benchmark control.',
    selectedProtocolFamily: 'ml_algorithm_benchmark',
    agentExecutionReceipt,
    producerId: 'agenda-authority-producer',
    generatedAt: '2026-07-19T00:00:00.000Z',
  });
  const preparationPayload = {
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    proposal: {
      objective: receipt.selectedObjective,
      protocolFamily: receipt.selectedProtocolFamily,
    },
    capabilityScopeManifest: manifest,
    researchAgendaProducerReceipt: receipt,
  };
  const preparation = {
    ...preparationPayload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', preparationPayload),
  };
  const planPayload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: 'agenda-authority-campaign',
    paperId: request.paperId,
    autonomousResearchPreparation: preparation,
  };
  const plan = {
    ...planPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
  };
  const inspect = (candidate) => inspectPersistedAutonomousResearchAgendaAuthority({
    store: {
      query: () => ({
        ok: true,
        rows: [{
          campaign_id: candidate.campaignId,
          paper_id: candidate.paperId,
          spec_json: JSON.stringify(candidate),
          updated_at: '2026-07-19T00:01:00.000Z',
        }],
      }),
    },
  });
  const authority = inspect(plan);
  assert.equal(authority.ready, false);
  assert.equal(authority.statusReadOnly, true);
  assert.equal(authority.researchAgendaProducerReceipt, null);

  const agendaSelectionReceipt = selectMachineGeneratedAutonomousResearchAgenda({
    paperId: request.paperId,
    researchAgendaProducerReceipt: receipt,
  });
  const researchAgendaIr = buildResearchAgendaIr({
    agendaProductionReceipt: receipt,
    researchQuestion: 'Does the generated intervention improve the registered metric?',
    primaryClaim: 'The generated intervention improves the registered primary metric.',
    dataRequirements: {
      population: 'Rows admitted by the signed benchmark contract.',
      intervention: 'Generated intervention.',
      comparator: 'Fixed benchmark control.',
      estimand: 'Paired primary-metric difference.',
      requiredVariables: ['outcome', 'assignment'],
      datasetConstraints: ['read-only signed dataset mount'],
    },
    falsifiers: ['A non-positive paired primary-metric difference.'],
    negativeBoundaries: ['No claim outside the signed benchmark population.'],
    formalTargets: ['Kernel-check the registered aggregation invariant.'],
    priorArtQueryPlan: ['Search the intervention and estimand concepts together.'],
    venueConstraints: {
      paperType: 'research_article',
      requiredSections: ['methods', 'results', 'limitations'],
      artifactRequired: true,
      anonymousReviewRequired: true,
    },
    resourceFeasibility: {
      maximumWallTimeMs: 3_600_000,
      maximumMemoryBytes: 8_589_934_592,
      maximumCpuCount: 4,
      executionEnvironment: 'signed-python-runtime-v1',
    },
  });
  const priorArtAuthority = productionPriorArtAuthorityFixture({
    paperId: request.paperId,
    agendaSelectionReceiptHash:
      agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
    researchAgendaIr,
  });
  const priorArtClaimAlignmentReceipt = buildConservativePriorArtClaimAlignment({
    researchAgendaIr,
    agendaSelectionReceipt,
    priorArtEvidenceReceipt: priorArtAuthority.priorArtReceipt,
  });
  const alignedPreparationPayload = {
    ...preparationPayload,
    proposal: {
      ...preparationPayload.proposal,
      agendaSelectionReceipt,
      agendaSelectionReceiptHash:
        agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
    },
    researchAgendaIr,
    priorArtReceipt: priorArtAuthority.priorArtReceipt,
    priorArtAuthorityVerificationBundle: priorArtAuthority.authorityBundle,
    priorArtAuthorityTrustConfiguration: priorArtAuthority.trustConfiguration,
    externalCapabilityTrustInspection:
      priorArtAuthority.externalCapabilityTrustInspection,
    priorArtClaimAlignmentReceipt,
  };
  const alignedPreparation = {
    ...alignedPreparationPayload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', alignedPreparationPayload),
  };
  const alignedPlanPayload = {
    ...planPayload,
    autonomousResearchPreparation: alignedPreparation,
  };
  const alignedPlan = {
    ...alignedPlanPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', alignedPlanPayload),
  };
  const alignedAuthority = inspect(alignedPlan);
  assert.equal(alignedAuthority.ready, false);
  assert.equal(alignedAuthority.priorArtClaimAlignmentReady, false);
  assert.equal(alignedAuthority.priorArtEvidenceReceipt, null);
  assert.equal(alignedAuthority.priorArtClaimAlignmentReceipt, null);

  const tamperedAlignmentPreparationPayload = structuredClone(alignedPreparationPayload);
  tamperedAlignmentPreparationPayload.priorArtClaimAlignmentReceipt.alignments[0]
    .closestWorkGap = 'This finite corpus proves universal novelty.';
  const tamperedAlignmentPreparation = {
    ...tamperedAlignmentPreparationPayload,
    autonomousResearchLoopPreparationReportHash: hashRecord(
      'AutonomousResearchLoopPreparationReport', tamperedAlignmentPreparationPayload,
    ),
  };
  const tamperedAlignmentPlanPayload = {
    ...alignedPlanPayload,
    autonomousResearchPreparation: tamperedAlignmentPreparation,
  };
  const tamperedAlignmentPlan = {
    ...tamperedAlignmentPlanPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', tamperedAlignmentPlanPayload),
  };
  const rejectedAlignment = inspect(tamperedAlignmentPlan);
  assert.equal(rejectedAlignment.ready, false);
  assert.equal(rejectedAlignment.priorArtClaimAlignmentReady, false);
  assert.equal(rejectedAlignment.priorArtEvidenceReceipt, null);
  assert.equal(rejectedAlignment.priorArtClaimAlignmentReceipt, null);

  const tamperedReceiptPlan = structuredClone(plan);
  tamperedReceiptPlan.autonomousResearchPreparation.researchAgendaProducerReceipt
    .selectedObjective = 'Tampered objective.';
  assert.equal(inspect(tamperedReceiptPlan).ready, false);
  const tamperedPreparationPlan = structuredClone(plan);
  tamperedPreparationPlan.autonomousResearchPreparation.proposal.objective = 'Tampered proposal.';
  assert.equal(inspect(tamperedPreparationPlan).ready, false);
  const tamperedPlan = structuredClone(plan);
  tamperedPlan.paperId = 'agenda-authority-other-paper';
  assert.equal(inspect(tamperedPlan).ready, false);
});

test('persisted agenda authority accepts only a strong production-run agenda', () => {
  const paperId = 'strong-agenda-authority-paper';
  const campaignId = 'strong-agenda-authority-campaign';
  const objective = 'Compare a generated intervention with a fixed benchmark control.';
  const fixture = genericManuscriptReleaseFixture({
    paperId,
    campaignId,
    objective,
    protocolFamily: 'ml_algorithm_benchmark',
  });
  const {
    autonomousResearchLoopPreparationReportHash: _fixturePreparationHash,
    ...fixturePreparationPayload
  } = fixture.preparation;
  const preparationPayload = {
    ...fixturePreparationPayload,
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
  };
  const preparation = {
    ...preparationPayload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', preparationPayload),
  };
  const receipt = preparation.researchAgendaProducerReceipt;
  const planPayload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId,
    autonomousResearchPreparation: preparation,
  };
  const plan = {
    ...planPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
  };
  const inspect = (candidate, options = {}) =>
    inspectPersistedAutonomousResearchAgendaAuthority({
      store: {
        query: () => ({
          ok: true,
          rows: [{
            campaign_id: candidate.campaignId,
            paper_id: candidate.paperId,
            spec_json: JSON.stringify(candidate),
            updated_at: fixture.preparation.observedAt,
          }],
        }),
      },
      currentPriorArtAuthorityTrustConfiguration:
        fixture.preparation.priorArtAuthorityTrustConfiguration,
      currentExternalCapabilityTrustInspection:
        fixture.preparation.externalCapabilityTrustInspection,
      now: new Date(fixture.preparation.observedAt),
      ...options,
    });
  const authority = inspect(plan);
  assert.equal(receipt.version, 3);
  assert.equal(authority.ready, true);
  assert.equal(authority.priorArtClaimAlignmentReady, true);
  assert.deepEqual(authority.researchAgendaIr, preparation.researchAgendaIr);
  assert.deepEqual(
    authority.priorArtClaimAlignmentReceipt,
    preparation.priorArtClaimAlignmentReceipt,
  );

  const {
    autonomousResearchLoopPreparationReportHash: _oldPreparationHash,
    ...productionPreparationPayload
  } = preparation;
  const goldenPayload = {
    ...productionPreparationPayload,
    launchMode: 'golden-bootstrap',
  };
  const goldenPreparation = {
    ...goldenPayload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', goldenPayload),
  };
  const goldenPlanPayload = {
    ...planPayload,
    autonomousResearchPreparation: goldenPreparation,
  };
  assert.equal(inspect({
    ...goldenPlanPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', goldenPlanPayload),
  }).ready, false);
});

test('resident heartbeat status is zero-write, fenced, and stale-instance recoverable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-instance-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const missingBefore = fileTree(root);
  const missing = inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date('2026-07-16T06:00:00.000Z'),
  });
  assert.equal(missing.healthy, false);
  assert.match(missing.blockers.join(','), /instance_missing/);
  assert.deepEqual(fileTree(root), missingBefore);

  const first = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  const second = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { first.close(); second.close(); });
  const startedAt = new Date('2026-07-16T06:00:00.000Z');
  const firstLease = first.acquireInstanceLease({
    ownerId: 'supervisor:first',
    leaseMs: 2000,
    heartbeatMs: 500,
    now: startedAt,
  });
  assert.ok(firstLease);
  assert.equal(second.acquireInstanceLease({
    ownerId: 'supervisor:duplicate',
    leaseMs: 2000,
    heartbeatMs: 500,
    now: new Date(startedAt.getTime() + 1000),
  }), null);

  const healthyBefore = fileTree(root);
  const healthy = inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(startedAt.getTime() + 1000),
  });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.ready, false);
  assert.match(healthy.blockers.join(','), /startup_reconciliation_incomplete/);
  assert.deepEqual(fileTree(root), healthyBefore);
  first.markStartupReconciled({
    lease: firstLease,
    receiptHash: H('resident-startup-reconciliation'),
    now: new Date(startedAt.getTime() + 1000),
  });
  const startupOnly = inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(startedAt.getTime() + 1001),
  });
  assert.equal(startupOnly.startupReady, true);
  assert.equal(startupOnly.ready, false);
  first.markMachineIntakeReconciled({
    lease: firstLease,
    receiptHash: H('resident-machine-intake-reconciliation'),
    configurationHash: H('resident-machine-intake-configuration'),
    now: new Date(startedAt.getTime() + 1001),
  });
  assert.equal(inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(startedAt.getTime() + 1002),
  }).ready, true);
  first.markMachineIntakeReconciliationFailed({
    lease: firstLease,
    reason: 'machine_intake_configuration_or_load_failed',
    now: new Date(startedAt.getTime() + 1002),
  });
  const failed = inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(startedAt.getTime() + 1003),
  });
  assert.equal(failed.startupReady, true);
  assert.equal(failed.ready, false);
  assert.equal(failed.instance.machineIntakeReconciliationReceiptHash, null);
  first.markMachineIntakeReconciled({
    lease: firstLease,
    receiptHash: H('resident-machine-intake-recovered'),
    configurationHash: H('resident-machine-intake-configuration'),
    now: new Date(startedAt.getTime() + 1003),
  });
  assert.equal(inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(startedAt.getTime() + 1004),
  }).ready, true);

  const expired = inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(startedAt.getTime() + 3004),
  });
  assert.equal(expired.healthy, false);
  assert.match(expired.blockers.join(','), /heartbeat_expired/);
  const replacementLease = second.acquireInstanceLease({
    ownerId: 'supervisor:replacement',
    leaseMs: 2000,
    heartbeatMs: 500,
    now: new Date(startedAt.getTime() + 3004),
  });
  assert.ok(replacementLease.leaseGeneration > firstLease.leaseGeneration);
  assert.equal(first.heartbeatInstanceLease({
    lease: firstLease,
    now: new Date(startedAt.getTime() + 3100),
  }), null);
  assert.equal(first.releaseInstanceLease({
    lease: firstLease,
    now: new Date(startedAt.getTime() + 3100),
  }), false);
  assert.equal(second.readInstance().recoveredLeaseCount, 1);
  assert.equal(second.readInstance().machineIntakeReconciliationReceiptHash, null);

  fs.chmodSync(first.databasePath, 0o666);
  const permissionAttack = inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(startedAt.getTime() + 3100),
  });
  assert.equal(permissionAttack.healthy, false);
  assert.match(permissionAttack.blockers.join(','), /state_invalid/);
  fs.chmodSync(first.databasePath, 0o600);
});

test('a greater-than-ten-minute event-loop stall cannot replace the default resident lease', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-stall-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const first = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  const second = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { first.close(); second.close(); });
  const startedAt = new Date('2026-07-16T06:10:00.000Z');
  const lease = first.acquireInstanceLease({
    ownerId: 'supervisor:sync-operation',
    now: startedAt,
  });
  assert.equal(lease.leaseMs, 15 * 60 * 1000);
  assert.equal(lease.heartbeatMs, 30_000);
  first.markStartupReconciled({
    lease,
    receiptHash: H('stall-startup-reconciliation'),
    now: startedAt,
  });
  first.markMachineIntakeReconciled({
    lease,
    receiptHash: H('stall-machine-intake-reconciliation'),
    configurationHash: H('stall-machine-intake-configuration'),
    now: startedAt,
  });
  const afterPermittedStall = new Date(startedAt.getTime() + 10 * 60 * 1000 + 1);
  assert.equal(second.acquireInstanceLease({
    ownerId: 'supervisor:false-replacement',
    now: afterPermittedStall,
  }), null);
  assert.ok(first.heartbeatInstanceLease({ lease, now: afterPermittedStall }));
  assert.equal(inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now: new Date(afterPermittedStall.getTime() + 1),
  }).ready, true);
  const afterExtendedExpiry = new Date(
    afterPermittedStall.getTime() + 15 * 60 * 1000 + 1,
  );
  const replacement = second.acquireInstanceLease({
    ownerId: 'supervisor:true-replacement',
    now: afterExtendedExpiry,
  });
  assert.ok(replacement.leaseGeneration > lease.leaseGeneration);
  assert.equal(first.heartbeatInstanceLease({
    lease,
    now: afterExtendedExpiry,
  }), null);
});

test('health CLI separates heartbeat, startup, and machine-intake readiness', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-resident-health-cli-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => repository.close());
  let now = new Date();
  const lease = repository.acquireInstanceLease({ ownerId: 'supervisor:health-cli', now });
  const run = (...flags) => spawnSync(process.execPath, [
    path.join(repositoryRoot, 'paper-core/bin/autonomous-research-supervisor-health.mjs'),
    '--runtime-root',
    runtimeRoot,
    ...flags,
  ], { encoding: 'utf8', timeout: 10_000 });
  const current = run();
  assert.equal(current.status, 0, `${current.stderr}\n${current.stdout}`);
  const strict = run('--require-fully-autonomous');
  assert.equal(strict.status, 2, `${strict.stderr}\n${strict.stdout}`);
  const strictReport = JSON.parse(strict.stdout);
  assert.equal(strictReport.fullyAutonomousReady, false);
  assert.equal(strictReport.autonomousStateSafetyReady, false);
  assert.equal(strictReport.autonomousStateSafety.ready, false);
  assert.ok(strictReport.autonomousStateSafetyBlockers.length > 0);
  assert.equal(run('--require-startup-reconciliation').status, 2);
  now = new Date(now.getTime() + 1);
  repository.markStartupReconciled({
    lease,
    receiptHash: H('health-cli-startup'),
    now,
  });
  assert.equal(run('--require-startup-reconciliation').status, 0);
  assert.equal(run('--require-machine-intake-reconciliation').status, 2);
  assert.equal(run('--require-current-machine-intake').status, 2);
  now = new Date(now.getTime() + 1);
  repository.markMachineIntakeReconciled({
    lease,
    receiptHash: H('health-cli-machine-intake'),
    configurationHash: H('health-cli-configuration'),
    now,
  });
  assert.equal(run('--require-machine-intake-reconciliation').status, 0);
  assert.equal(run('--require-current-machine-intake').status, 2);
  now = new Date(now.getTime() + 1);
  repository.markMachineIntakeReconciliationFailed({
    lease,
    reason: 'machine_intake_configuration_or_load_failed',
    now,
  });
  assert.equal(run('--require-startup-reconciliation').status, 0);
  assert.equal(run('--require-machine-intake-reconciliation').status, 2);
});

test('readiness health probe rereads the current intake authority and fails on drift', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-current-intake-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const staticPath = path.join(root, 'production-intake.json');
  const configPath = path.join(root, 'intake-config.json');
  const production = productionIntake();
  writeJson(staticPath, production);
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{ path: staticPath, intakeHash: production.intakeHash }],
    recurringGoldenTemplates: [recurringTemplate()],
    machineAppendEnabled: false,
  });
  writeJson(configPath, configuration);
  const intakeRepository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: configuration.configurationHash,
  });
  t.after(() => intakeRepository.close());
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => instanceRepository.close());
  const now = new Date();
  const lease = instanceRepository.acquireInstanceLease({
    ownerId: 'supervisor:current-intake',
    now,
  });
  instanceRepository.markStartupReconciled({
    lease,
    receiptHash: H('current-intake-startup'),
    now,
  });
  instanceRepository.markMachineIntakeReconciled({
    lease,
    receiptHash: H('current-intake-reconciliation'),
    configurationHash: configuration.configurationHash,
    now,
  });
  const run = () => spawnSync(process.execPath, [
    path.join(repositoryRoot, 'paper-core/bin/autonomous-research-supervisor-health.mjs'),
    '--runtime-root',
    runtimeRoot,
    '--require-current-machine-intake',
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath },
  });
  const currentAuthority = run();
  assert.equal(currentAuthority.status, 0,
    `${currentAuthority.stderr}\n${currentAuthority.stdout}`);
  writeJson(staticPath, { ...production, objective: 'Drifted after reconciliation.' });
  assert.equal(run().status, 2);
});

test('canonical v2 readiness remeasures the topic profile and dataset source after startup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-current-v2-profile-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const datasetSource = path.join(root, 'registered-dataset');
  const replacementDataset = path.join(root, 'replacement-dataset');
  const profilePath = path.join(root, 'topic-producer-profile.json');
  const configPath = path.join(root, 'intake-config.json');
  fs.mkdirSync(datasetSource, { mode: 0o700 });
  fs.mkdirSync(replacementDataset, { mode: 0o700 });
  fs.writeFileSync(path.join(datasetSource, 'benchmark.json'), '{"rows":1}\n');
  const profile = topicProducerProfile({ datasetSource });
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [recurringTemplate()],
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  writeJson(profilePath, profile);
  writeJson(configPath, configuration);
  const externalAuthority = installMachineIntakeExternalGenesisAuthority({
    configurationHash: configuration.configurationHash,
    producerProfileHash: profile.producerProfileHash,
  });
  const externalAuthorityPath = path.join(root, 'external-authority-test-fixture.json');
  writeJson(externalAuthorityPath, externalAuthority);

  const topicRepository = createAutonomousResearchTopicProducerRepository({
    runtimeRoot,
    machineIntakeConfigurationHash: configuration.configurationHash,
    producerProfile: profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority: { consume() {} },
  });
  t.after(() => topicRepository.close());
  assert.ok(topicRepository.tryAcquireLease({
    ownerId: 'producer:current-v2-profile-health',
    leaseMs: 60_000,
    now: new Date(),
  }));
  const intakeRepository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: configuration.configurationHash,
    authorizedMachineProducerProfileHash: profile.producerProfileHash,
    machineProducerAppendAuthority: topicRepository,
  });
  t.after(() => intakeRepository.close());
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => instanceRepository.close());
  const now = new Date();
  const lease = instanceRepository.acquireInstanceLease({
    ownerId: 'supervisor:current-v2-profile-health',
    now,
  });
  instanceRepository.markStartupReconciled({
    lease,
    receiptHash: H('current-v2-profile-startup'),
    now,
  });
  instanceRepository.markMachineIntakeReconciled({
    lease,
    receiptHash: H('current-v2-profile-reconciliation'),
    configurationHash: configuration.configurationHash,
    datasetSnapshotHash: readAutonomousResearchTopicProducerProfile({
      profilePath,
      environment: { HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: root },
    }).datasetSnapshot.datasetSnapshotHash,
    now,
  });
  const run = ({ includeDatasetRoot = true } = {}) => spawnSync(process.execPath, [
    path.join(repositoryRoot, 'paper-core/bin/autonomous-research-supervisor-health.mjs'),
    '--runtime-root',
    runtimeRoot,
    '--require-current-machine-intake',
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      NODE_OPTIONS: `--import=${path.join(
        repositoryRoot,
        'paper-core/tests/test-doubles/machine-intake-external-authority-preload.mjs',
      )}`,
      HEPTA_TEST_MACHINE_INTAKE_EXTERNAL_AUTHORITY: externalAuthorityPath,
      HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath,
      HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE: profilePath,
      ...(includeDatasetRoot
        ? { HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: root } : {}),
    },
  });

  assert.equal(run({ includeDatasetRoot: false }).status, 2);
  const current = run();
  assert.equal(current.status, 0, `${current.stderr}\n${current.stdout}`);

  fs.rmSync(datasetSource, { recursive: true });
  const missingDataset = run();
  assert.equal(missingDataset.status, 2, missingDataset.stdout);
  assert.match(JSON.parse(missingDataset.stdout).currentMachineIntakeBlockers.join(','),
    /producer_admission_capability_required/);

  fs.symlinkSync(replacementDataset, datasetSource, 'dir');
  assert.equal(run().status, 2);
  fs.rmSync(datasetSource);
  fs.mkdirSync(datasetSource, { mode: 0o700 });
  assert.equal(run().status, 2);

  fs.writeFileSync(path.join(datasetSource, 'benchmark.json'), '{"rows":1}\n');
  assert.equal(run().status, 0);

  fs.rmSync(profilePath);
  assert.equal(run().status, 2);
  writeJson(profilePath, profile);
  assert.equal(run().status, 0);

  writeJson(profilePath, topicProducerProfile({
    datasetSource,
    producerId: 'replacement-system-status-topic-producer',
    implementationSha256: H('undeployed-topic-producer-implementation'),
  }));
  assert.equal(run().status, 2);
});

test('topic-producer profile enforces a realpath-contained dataset root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-topic-dataset-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const datasetRoot = path.join(root, 'datasets');
  const legalDataset = path.join(datasetRoot, 'legal-dataset');
  const outsideDataset = path.join(root, 'outside-dataset');
  const profilePath = path.join(root, 'profile.json');
  fs.mkdirSync(legalDataset, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outsideDataset, { mode: 0o700 });
  fs.mkdirSync(path.join(outsideDataset, 'child'), { mode: 0o700 });
  const environment = { HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: datasetRoot };
  writeJson(profilePath, topicProducerProfile({
    datasetSource: legalDataset,
    producerId: 'contained-dataset-topic-producer',
  }));
  assert.equal(readAutonomousResearchTopicProducerProfile({ profilePath, environment })
    .producerProfile.producerId, 'contained-dataset-topic-producer');
  assert.throws(() => readAutonomousResearchTopicProducerProfile({
    profilePath,
    environment: {},
  }), /autonomous_research_topic_producer_dataset_root_required/);

  writeJson(profilePath, topicProducerProfile({
    datasetSource: `${datasetRoot}${path.sep}..${path.sep}outside-dataset`,
    producerId: 'outside-dataset-topic-producer',
  }));
  assert.throws(() => readAutonomousResearchTopicProducerProfile({
    profilePath,
    environment,
  }), /autonomous_research_topic_producer_dataset_source_invalid/);

  const linkedParent = path.join(datasetRoot, 'linked-parent');
  fs.symlinkSync(outsideDataset, linkedParent, 'dir');
  writeJson(profilePath, topicProducerProfile({
    datasetSource: path.join(linkedParent, 'child'),
    producerId: 'parent-symlink-topic-producer',
  }));
  assert.throws(() => readAutonomousResearchTopicProducerProfile({
    profilePath,
    environment,
  }), /autonomous_research_topic_producer_dataset_source_invalid/);

  writeJson(profilePath, topicProducerProfile({
    datasetSource: 'working-directory-dependent-dataset',
    producerId: 'relative-dataset-topic-producer',
  }));
  assert.throws(() => readAutonomousResearchTopicProducerProfile({
    profilePath,
    environment,
  }),
    /autonomous_research_topic_producer_dataset_source_invalid/);
});

test('machine-intake status is zero-write and machine append cannot impersonate a producer', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-system-intake-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const missing = inspectAutonomousResearchMachineIntakeStatus({
    runtimeRoot,
    environment: {},
  });
  assert.equal(missing.coldStartAutonomyReady, false);
  assert.match(missing.blockers.join(','), /configuration_missing/);
  assert.equal(fs.existsSync(runtimeRoot), false);

  const configPath = path.join(root, 'intake-config.json');
  writeJson(configPath, buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [recurringTemplate()],
    machineAppendEnabled: true,
  }));
  const before = fileTree(root);
  const incomplete = inspectAutonomousResearchMachineIntakeStatus({
    runtimeRoot,
    environment: { HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath },
  });
  assert.equal(incomplete.coldStartAutonomyReady, false);
  assert.equal(incomplete.recurringGoldenReady, true);
  assert.equal(incomplete.productionIntakeReady, false);
  assert.equal(incomplete.machineAppendAuthorized, true);
  assert.equal(incomplete.machineProducerAdmissionCapabilityReady, false);
  assert.match(incomplete.blockers.join(','), /producer_admission_capability_required/);
  assert.deepEqual(fileTree(root), before);
});

test('valid cold-start config is ready while static-content drift blocks status without writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-system-intake-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const staticPath = path.join(root, 'production-intake.json');
  const configPath = path.join(root, 'intake-config.json');
  const production = productionIntake();
  writeJson(staticPath, production);
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{ path: staticPath, intakeHash: production.intakeHash }],
    recurringGoldenTemplates: [recurringTemplate()],
    machineAppendEnabled: false,
  });
  writeJson(configPath, configuration);
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: configuration.configurationHash,
  });
  repository.close();
  const validBefore = fileTree(root);
  const valid = inspectAutonomousResearchMachineIntakeStatus({
    runtimeRoot,
    environment: { HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath },
  });
  assert.equal(valid.coldStartAutonomyReady, true);
  assert.equal(valid.recurringGoldenReady, true);
  assert.equal(valid.productionIntakeReady, true);
  assert.equal(valid.recurringGoldenProviderConfigurationBound, true);
  assert.equal(valid.staticIntakeProviderConfigurationBound, true);
  assert.equal(valid.repositoryConfigurationAuthorityBound, true);
  assert.deepEqual(fileTree(root), validBefore);

  writeJson(staticPath, { ...production, objective: 'Attacker changed the objective.' });
  const driftedBefore = fileTree(root);
  const drifted = inspectAutonomousResearchMachineIntakeStatus({
    runtimeRoot,
    environment: { HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath },
  });
  assert.equal(drifted.coldStartAutonomyReady, false);
  assert.match(drifted.blockers.join(','), /configuration_invalid_or_drifted/);
  assert.deepEqual(fileTree(root), driftedBefore);
});

test('hash-valid intake config rotation cannot outvote the durable repository authority', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-system-intake-rotation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const staticPath = path.join(root, 'production-intake.json');
  const configPath = path.join(root, 'intake-config.json');
  const production = productionIntake();
  writeJson(staticPath, production);
  const initial = buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{ path: staticPath, intakeHash: production.intakeHash }],
    recurringGoldenTemplates: [recurringTemplate()],
    machineAppendEnabled: false,
  });
  writeJson(configPath, initial);
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  });
  repository.close();

  const replacement = buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{ path: staticPath, intakeHash: production.intakeHash }],
    recurringGoldenTemplates: [recurringTemplate({
      objective: 'Continuously qualify a substituted unattended research authority.',
    })],
    machineAppendEnabled: false,
  });
  writeJson(configPath, replacement);
  const before = fileTree(root);
  const status = inspectAutonomousResearchMachineIntakeStatus({
    runtimeRoot,
    environment: { HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath },
  });
  assert.equal(status.configurationValid, true);
  assert.equal(status.configurationReady, true);
  assert.equal(status.repositoryConfigurationAuthorityBound, false);
  assert.equal(status.coldStartAutonomyReady, false);
  assert.equal(status.state.configuredSourceAuthorityHash, initial.configurationHash);
  assert.match(status.blockers.join(','), /repository_configuration_authority_mismatch/);
  assert.deepEqual(fileTree(root), before);
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: replacement.configurationHash,
  }), /configuration_authority_mismatch/);
});

test('machine-intake readiness rejects hash-valid provider substitution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-system-intake-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const staticPath = path.join(root, 'production-intake.json');
  const configPath = path.join(root, 'intake-config.json');
  const substitutedHash = H('substituted-provider-configuration');
  const production = buildAutonomousResearchMachineIntake({
    ...productionIntake(),
    providerConfigurationHash: substitutedHash,
  });
  const recurring = buildAutonomousResearchRecurringGoldenTemplate({
    ...recurringTemplate(),
    providerConfigurationHash: substitutedHash,
  });
  writeJson(staticPath, production);
  writeJson(configPath, buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{ path: staticPath, intakeHash: production.intakeHash }],
    recurringGoldenTemplates: [recurring],
    machineAppendEnabled: false,
  }));
  const before = fileTree(root);
  const status = inspectAutonomousResearchMachineIntakeStatus({
    runtimeRoot,
    environment: { HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath },
  });
  assert.equal(status.configurationValid, true);
  assert.equal(status.coldStartAutonomyReady, false);
  assert.equal(status.recurringGoldenProviderConfigurationBound, false);
  assert.equal(status.staticIntakeProviderConfigurationBound, false);
  assert.match(status.blockers.join(','), /provider_configuration_mismatch/);
  assert.deepEqual(fileTree(root), before);
});
