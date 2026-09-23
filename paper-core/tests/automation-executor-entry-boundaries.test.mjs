import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCodexAgentExecutor,
} from '../../paper-adapters/automation/codex-agent-executor.mjs';
import {
  createMultiLanguageEmpiricalExecutor,
} from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  evaluateAcademicEmpiricalReadiness,
  probeOsSandbox,
} from '../../paper-adapters/runtime/sandbox-backend-probe.mjs';
import {
  executableRuntimePathSupported,
} from '../../paper-adapters/runtime/runtime-resource-mounts.mjs';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import { fileSha256Hash } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  buildCampaignAgentInstructions,
  buildCampaignAgentExecutionRequest,
  buildFormalProofRepairRequest,
  bindFormalProofSearchCandidateRequest,
} from '../../paper-application/automation/campaign-agent-policy.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  selectAutonomousFormalSupportTemplate,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  buildCampaignWorkerAllowedRoots,
  buildCampaignWorkerRuntimeImageConfiguration,
  prepareCampaignAttemptWorkspaceRoot,
  prepareCampaignAutomationArtifactRoot,
} from '../../paper-composition/automation/campaign-worker-empirical-composition.mjs';

function trustedDatasetSupervisorProfile(runtime) {
  return {
    image: runtime.image,
    imageDigest: runtime.imageDigest,
    containerExecutable: runtime.executable,
    supervisor: runtime.datasetAccessSupervisor,
  };
}

function trustedDockerImageInspection(runtime) {
  return {
    status: 0,
    stdout: JSON.stringify([{
      Descriptor: {
        digest: runtime.imageDigest,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
      },
      Os: 'linux',
      Architecture: 'amd64',
      Config: { Labels: {
        'io.hepta.dataset-supervisor.protocol':
          runtime.datasetAccessSupervisor.protocol,
        'io.hepta.dataset-supervisor.sha256':
          runtime.datasetAccessSupervisor.sha256,
      } },
    }]),
    stderr: '',
  };
}

test('sandbox recognizes a plan-bound Elan toolchain below a custom ELAN_HOME', () => {
  assert.equal(executableRuntimePathSupported(
    '/opt/hepta-paper/elan/toolchains/leanprover--lean4---v4.30.0/bin/lean',
    '/srv/hepta-paper/formal/project',
  ), true);
  assert.equal(executableRuntimePathSupported(
    '/opt/hepta-paper/elan/not-toolchains/lean/bin/lean',
    '/srv/hepta-paper/formal/project',
  ), false);
});

test('trusted factory executable hashes reject substitution before execution identity issuance', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-trusted-executable-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const executable = path.join(root, 'lake');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Main.lean'), 'example : True := by trivial\n');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(executable, 0o755);
  const expectedHash = fileSha256Hash(executable);
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [executable],
    expectedExecutableHashes: { [executable]: expectedHash },
    allowedRoots: [source],
    probe: {
      available: true,
      backend: 'bubblewrap',
      status: 'os_sandbox_available',
      processLimit: { available: true, mechanism: 'fixture' },
    },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 7\n');
  fs.chmodSync(executable, 0o755);
  const receipt = runner.run({
    executable,
    args: [],
    cwd: source,
    sourceRoot: source,
  });
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.includes('worker_expected_executable_hash_mismatch'));
  assert.equal(executions, 0);
});

test('campaign coder contract writes canonical metric artifacts only through HEPTA_OUTPUT_DIR', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'coder-python',
    manuscript: 'main.tex',
    language: 'python',
  });
  assert.match(instructions, /HEPTA_OUTPUT_DIR\/results\.json/);
  assert.match(instructions, /HEPTA_OUTPUT_DIR\/results\.csv/);
  assert.match(instructions, /writable surface is exactly experiments\/run\.py\./);
  assert.doesNotMatch(instructions, /run\.treatment\.py|run\.baseline\.py|run\.ablation\.py/);
  assert.match(instructions, /exact header metric,value/);
  assert.match(instructions, /do not fall back to the working directory/i);
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: { availability: {}, run() { throw new Error('must not execute'); } },
  });
  const blocked = executor.execute({
    language: 'python', requireSeparateOutputRoot: true, env: {},
  });
  assert.equal(blocked.status, 'empirical_output_contract_invalid');
  assert.deepEqual(blocked.blockers, ['empirical_output_directory_binding_invalid']);
});

test('ICLR venue migration instructions are local, provenance-preserving, and target-aware', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'revise',
    manuscript: 'main.tex',
    targetVenue: 'ICLR',
    sourceVenue: 'NeurIPS 2026',
  });
  assert.match(instructions, /local NeurIPS 2026-to-ICLR rewrite/i);
  assert.match(instructions, /copy-on-write workspace/i);
  assert.match(instructions, /never edit SOURCE_WORKSPACE\.json, paper\.json/i);
  assert.match(instructions, /Remove NeurIPS-specific style\/checklist\/deadline language/i);
  assert.match(instructions, /double-blind anonymity/i);
  assert.match(instructions, /do not upload, submit, contact an ICLR portal/i);
});

test('system benchmark coder contract locates cases under each cell challenge', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'coder-r',
    manuscript: 'main.tex',
    language: 'r',
    benchmarkSelector: buildCampaignBenchmarkSelector({
      benchmarkId: 'finance_asset_pricing_benchmark',
    }),
  });
  assert.match(instructions, /iterate cell\.challenge\.cases, never cell\.cases/i);
  assert.match(instructions, /cell\.cases does not exist/i);
  assert.match(
    instructions,
    /writable surface is exactly experiments\/run\.R, experiments\/run\.treatment\.R, experiments\/run\.baseline\.R, experiments\/run\.ablation\.R/,
  );
  assert.match(instructions, /Inspect only RESEARCH_PLAN\.md and those writable files/);
  assert.match(instructions, /do not inspect, restate, or rewrite another language's entrypoints/);
  assert.match(instructions, /make no edits and report only concise checks/);
  assert.match(instructions, /replacement bodies only for writable files whose bytes must change/);
});

test('formal author contract distinguishes exact source contracts from generic kernel output', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'formal-author', manuscript: 'main.tex',
  });
  assert.match(instructions, /place explicit binders before the declaration colon/);
  assert.match(instructions, /spell the result type exactly as '#check' prints it/);
  assert.match(instructions, /dynamic claim.*declare exactly 'theorem leanDeclarationName : leanTypeSource/);
  assert.match(instructions, /preserving leanTypeSource after the colon even when it begins with '∀'/);
  assert.match(instructions, /exact non-dynamic registry-bound claim is also an exception/);
  assert.match(instructions, /preserve the registry expectedType byte-for-byte/);
  assert.match(instructions, /Do not put the complete type after the colon as an explicit '∀.*generic claim/);
  assert.match(instructions, /SYSTEM_ALLOWED_FORMAL_AXIOMS=\[\]/);
  assert.match(instructions, /reports propext, Quot\.sound, or any other axiom/);
  assert.match(instructions, /unfold the defining function before splitting its cases/);
  assert.doesNotMatch(instructions, /Nat\.min|loss_cap_upper_bound|change \(if loss ≤ cap/);
  assert.match(instructions, /host unconditionally rebuilds RESEARCH_WORKER_PLAN\.json/);
  assert.match(instructions, /lakefile\.lean, and lake-manifest\.json/);
  assert.match(instructions, /never create or edit those system-owned files/);
  assert.match(instructions, /never calculate or self-author their SHA-256 values/);
  assert.match(instructions, /exactly one top-level theorem or lemma declaration for each canonical claim/);
  assert.match(instructions, /do not create helper theorem or lemma declarations/);
  assert.match(instructions, /requires at least one non-lakefile \.lean source/);
  assert.match(instructions, /stale verification commentary.*never a reason to skip Lean authoring/);
  assert.match(instructions, /run the pinned local Lean executable directly against each source/);
});

test('kernel-audited loss-cap proof is scoped to the exact registry-bound obligation', () => {
  const campaign = {
    campaignId: 'campaign-formal-proof-contract',
    paperId: 'paper-formal-proof-contract',
    spec: {
      datasetMounts: [],
      manuscript: 'main.tex',
      paperQualityProfiles: ['formal_theorem_or_proof'],
    },
  };
  const author = buildCampaignAgentExecutionRequest({
    campaign,
    node: { kind: 'formal-author', nodeId: 'formal-author' },
    workspace: '/tmp/formal-author',
    manuscript: 'main.tex',
    reviews: [],
    executionBudget: { remainingTokenCount: 10_000, remainingWallTimeMs: 60_000 },
  });
  const repair = buildFormalProofRepairRequest({
    campaign,
    workspace: '/tmp/formal-repair',
    manuscript: 'main.tex',
    diagnostics: '{"axioms":["propext"]}',
    iteration: 1,
    remainingTokenCount: 10_000,
  });
  const candidate = Object.freeze({
    ordinal: 0,
    strategy: 'direct_elaboration',
    requiredOperations: Object.freeze([]),
    theoremSpecificationHash: `sha256:${'e'.repeat(64)}`,
    typedTheoremObligationBundleHash: `sha256:${'a'.repeat(64)}`,
  });
  const formalProofSearchPlan = Object.freeze({
    candidateCount: 1,
    candidates: Object.freeze([candidate]),
    theoremSpecificationHash: candidate.theoremSpecificationHash,
    typedTheoremObligationBundleHash: candidate.typedTheoremObligationBundleHash,
    formalProofSearchPlanHash: `sha256:${'b'.repeat(64)}`,
  });
  const genericSpecification = (proofObligation) => Object.freeze({
    theoremSpecificationHash: candidate.theoremSpecificationHash,
    claims: Object.freeze([Object.freeze({
      proofObligationContracts: Object.freeze([Object.freeze({
        displayText: proofObligation,
      })]),
    })]),
  });
  const bindRequest = (request, theoremSpecification) => bindFormalProofSearchCandidateRequest({
    request,
    typedTheoremObligationBundle: Object.freeze({
      obligations: Object.freeze([]),
      theoremSpecificationHash: candidate.theoremSpecificationHash,
      typedTheoremObligationBundleHash: candidate.typedTheoremObligationBundleHash,
    }),
    theoremSpecification,
    formalProofSearchPlan,
    candidate,
  });
  const baseRequests = [author, repair];
  for (const request of baseRequests) {
    assert.match(request.instructions, /dynamic claim.*leanTypeSource/);
    assert.match(request.instructions, /preserving leanTypeSource after the colon even when it begins with '∀'/);
    assert.match(request.instructions, /registry expectedType byte-for-byte after the (?:declaration )?colon/);
    assert.match(request.instructions, /explicit binders before the declaration colon/);
    assert.match(request.instructions, /propext, Quot\.sound/);
    assert.match(request.instructions, /reduction is definitional/);
  }
  const genericRequests = baseRequests.map(
    (request) => bindRequest(request, genericSpecification('prove_reflexive_identity')),
  );
  const nameOnlyLossCapRequests = baseRequests.map(
    (request) => bindRequest(request, genericSpecification('loss_cap_upper_bound')),
  );
  for (const request of [...baseRequests, ...genericRequests, ...nameOnlyLossCapRequests]) {
    assert.doesNotMatch(request.instructions, /use this already kernel-audited declaration verbatim/);
    assert.doesNotMatch(request.instructions, /theorem loss_cap_upper_bound/);
    assert.doesNotMatch(request.instructions, /theorem length_filter_le/);
  }
  const claimAuthorityBindingHash = `sha256:${'c'.repeat(64)}`;
  const claimAuthorityBundleHash = `sha256:${'d'.repeat(64)}`;
  const registryBoundSpecification = (template, claimKey) => Object.freeze({
    theoremSpecificationHash: candidate.theoremSpecificationHash,
    claimAuthorityType: 'machine-policy-authorized',
    proposalClaimLineageRequired: true,
    claimAuthorityBindingHash,
    claimAuthorityBundleHash,
    claims: Object.freeze([Object.freeze({
      claimKey,
      assumptions: template.scope.assumptions,
      quantifiers: template.scope.quantifiers,
      negativeBoundaries: template.scope.negativeBoundaries,
      proofObligations: template.scope.proofObligations,
      proposalClaimSource: Object.freeze({
        claimAuthorityType: 'machine-policy-authorized',
        claimAuthorityBindingHash,
        claimAuthorityBundleHash,
        proposalClaimText: template.scope.statement,
        scientificClaimKey: claimKey,
        assumptions: template.scope.assumptions,
        quantifiers: template.scope.quantifiers,
        negativeBoundaries: template.scope.negativeBoundaries,
        proofObligations: template.scope.proofObligations,
      }),
      proofObligationContracts: Object.freeze([Object.freeze({
        displayText: template.leanTypeContract.proofObligation,
      })]),
    })]),
  });
  const template = selectAutonomousFormalSupportTemplate('finance_asset_pricing_benchmark');
  const registryBoundLossCapSpecification = registryBoundSpecification(
    template,
    'registry-loss-cap',
  );
  const lossCapRequests = baseRequests.map(
    (request) => bindRequest(request, registryBoundLossCapSpecification),
  );
  for (const request of lossCapRequests) {
    assert.match(request.instructions, /use this already kernel-audited declaration verbatim/);
    assert.match(request.instructions, /theorem loss_cap_upper_bound : ∀ \(loss cap : Nat\), Nat\.min loss cap ≤ cap := by/);
    assert.match(request.instructions, /change \(if loss ≤ cap then loss else cap\) ≤ cap/);
    assert.match(request.instructions, /Do not replace its change step with rw, simp, omega/);
  }
  const scheduleTemplate = selectAutonomousFormalSupportTemplate('ml_algorithm_benchmark');
  const registryBoundScheduleSpecification = registryBoundSpecification(
    scheduleTemplate,
    'registry-schedule-filter',
  );
  const scheduleRequests = baseRequests.map(
    (request) => bindRequest(request, registryBoundScheduleSpecification),
  );
  for (const request of scheduleRequests) {
    assert.match(request.instructions, /exact registry-bound length_filter_le obligation/);
    assert.match(request.instructions, /theorem length_filter_le : ∀ \{α : Type\}/);
    assert.match(request.instructions, /unfold List\.filter/);
    assert.match(request.instructions, /Nat\.le_succ_of_le ih/);
    assert.match(request.instructions, /Nat\.succ_le_succ ih/);
    assert.match(request.instructions, /preserves the registry's explicit-∀ expectedType source identity/);
    assert.doesNotMatch(request.instructions, /theorem loss_cap_upper_bound/);
  }
  for (const protocolFamily of [
    'econometrics_panel_benchmark',
    'operations_optimization_benchmark',
    'rl_stochastic_control_benchmark',
  ]) {
    const auditedTemplate = selectAutonomousFormalSupportTemplate(protocolFamily);
    const specification = registryBoundSpecification(
      auditedTemplate,
      `registry-${protocolFamily}`,
    );
    const request = bindRequest(author, specification);
    assert.equal(request.instructions.includes(
      `theorem ${auditedTemplate.leanTypeContract.canonicalTheoremName} : ${auditedTemplate.leanTypeContract.expectedType} := by`,
    ), true, protocolFamily);
    assert.match(request.instructions, /already kernel-audited declaration verbatim/);
    assert.match(request.instructions, /explicit-∀ expectedType source identity/);
  }
  const scalarTemplate = selectAutonomousFormalSupportTemplate(
    'registered_scalar_response_benchmark',
  );
  assert.throws(() => bindRequest(author, registryBoundSpecification(
    scalarTemplate,
    'registry-scalar-response',
  )), (error) => {
    assert.equal(error.retryable, false);
    assert.match(error.message,
      /formal_registry_template_execution_closure_unavailable:registered_scalar_interval_preservation/);
    return true;
  });
  const invalidRegistrySpecifications = [
    (specification) => { specification.claimAuthorityType = 'operator-signed'; },
    (specification) => {
      specification.claims[0].proposalClaimSource.dynamicFormalClaimSeedHash = `sha256:${'f'.repeat(64)}`;
    },
    (specification) => {
      specification.claims[0].proposalClaimSource.claimAuthorityBindingHash = `sha256:${'f'.repeat(64)}`;
    },
    (specification) => {
      specification.claims[0].proposalClaimSource.assumptions = ['different scope'];
    },
  ].map((mutate) => {
    const specification = structuredClone(registryBoundLossCapSpecification);
    mutate(specification);
    return specification;
  });
  for (const theoremSpecification of invalidRegistrySpecifications) {
    for (const request of baseRequests.map((base) => bindRequest(base, theoremSpecification))) {
      assert.doesNotMatch(request.instructions, /use this already kernel-audited declaration verbatim/);
      assert.doesNotMatch(request.instructions, /theorem loss_cap_upper_bound/);
    }
  }
});

test('formal reviewer copies system-finalized domain identities without comparing hash domains', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'formal-review', manuscript: 'main.tex',
  });
  assert.match(instructions, /Copy claimId, theoremName, manuscriptClaimHash/);
  assert.match(instructions, /manuscriptClaimHash is the domain-separated ManuscriptClaimIdentity/);
  assert.match(instructions, /not manuscriptSource\.contentHash/);
  assert.match(instructions, /sourceManuscriptHash is a domain-separated FormalManuscriptCorpus record hash/);
  assert.match(instructions, /comparing those two different hash domains is invalid/);
});

test('local formal reviewer requires the same system-finalized worker binding', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'formal-review', manuscript: 'main.tex',
  });
  assert.match(instructions, /RESEARCH_WORKER_PLAN\.json is rebuilt by the system immediately before each review/);
  assert.match(instructions, /binder relocation alone is not a semantic or type mismatch/);
  assert.match(instructions, /dynamic claim.*exact bound leanTypeSource/);
  assert.match(instructions, /Copy claimId, theoremName, manuscriptClaimHash/);
});

test('machine-authorized campaign referee treats a missing entailment contract as a revise finding', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'referee-1', manuscript: 'main.tex', roundIndex: 1,
    claimAuthorityType: 'machine-policy-authorized',
  });
  assert.match(instructions, /If the contract is absent, return a completed revise review/);
  assert.match(instructions, /omit evidenceEntailmentReview/);
  assert.match(instructions, /is not a transport blocker/);
});

test('generic local campaign referee does not require an inapplicable entailment contract', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'referee-1', manuscript: 'main.tex', roundIndex: 1,
  });
  assert.match(instructions, /not in the trusted autonomous manuscript entailment mode/);
  assert.match(instructions, /do not report its presence or absence as a manuscript finding/);
  assert.doesNotMatch(instructions, /absence prevents acceptance/);
});

test('operator-signed campaign referee does not require the autonomous entailment contract', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'referee-1', manuscript: 'main.tex', roundIndex: 1,
    claimAuthorityType: 'operator-signed',
  });
  assert.match(instructions, /not in the trusted autonomous manuscript entailment mode/);
  assert.match(instructions, /AUTONOMOUS_MANUSCRIPT_ENTAILMENT\.json is not applicable/);
  assert.doesNotMatch(instructions, /absence prevents acceptance/);
});

test('pre-revision referee leaves current formal binding to downstream stages', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'referee-1', manuscript: 'main.tex', roundIndex: 1,
    formalVerificationScheduled: true,
  });
  assert.match(instructions, /graph runs revise, then theorem-spec, then formal-verify/);
  assert.match(instructions, /not a manuscript deficiency/);
  assert.match(instructions, /Do not ask the reviser to create, rebind, or verify/);
});

test('referee-only graph does not promise unscheduled formal stages', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'referee-1', manuscript: 'main.tex', roundIndex: 1,
  });
  assert.doesNotMatch(instructions, /graph runs revise, then theorem-spec, then formal-verify/);
  assert.doesNotMatch(instructions, /current-round canonical THEOREM_SPEC\.json/);
});

test('agent request derives the formal stage boundary from the persisted graph', () => {
  const campaign = {
    campaignId: 'campaign-stage-boundary',
    paperId: 'paper-stage-boundary',
    spec: {
      datasetMounts: [],
      manuscript: 'main.tex',
      paperQualityProfiles: ['formal_theorem_or_proof'],
    },
  };
  const node = {
    nodeId: 'campaign-stage-boundary:1:referee-1',
    kind: 'referee-1',
    roundIndex: 1,
  };
  const request = (campaignNodes) => buildCampaignAgentExecutionRequest({
    campaign, node, campaignNodes,
    workspace: '/tmp/stage-boundary', manuscript: 'main.tex', reviews: [],
    executionBudget: { remainingTokenCount: 10_000, remainingWallTimeMs: 60_000 },
  });
  assert.doesNotMatch(
    request([node]).instructions,
    /graph runs revise, then theorem-spec, then formal-verify/,
  );
  assert.match(
    request([
      node,
      { kind: 'theorem-spec', roundIndex: 1 },
      { kind: 'formal-verify', roundIndex: 1 },
    ]).instructions,
    /graph runs revise, then theorem-spec, then formal-verify/,
  );
});

test('generic campaign writers cannot invent research evidence or scholarly identities', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'writer',
    manuscript: 'main.tex',
  });
  assert.match(instructions, /Do not invent results, datasets, benchmark names, citations/);
  assert.match(instructions, /omit empirical findings and citations/);
  assert.match(instructions, /state the evidence limitations/);
});

test('academic empirical readiness is distinct from a generic Docker sandbox', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-academic-empirical-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracer = path.join(root, 'strace');
  fs.writeFileSync(tracer, 'fixture\n');
  fs.chmodSync(tracer, 0o755);
  const dockerFallback = evaluateAcademicEmpiricalReadiness({
    bubblewrapProbe: {
      available: false, backend: 'bubblewrap', detail: 'Operation not permitted',
    },
    datasetAccessTracer: tracer,
  });
  assert.equal(dockerFallback.academicEmpiricalReady, false);
  assert.equal(
    dockerFallback.academicEmpiricalReadinessReason,
    'academic_empirical_bubblewrap_backend_unavailable',
  );
  assert.match(dockerFallback.academicEmpiricalReadinessDetail, /Operation not permitted/);

  const missingTracer = evaluateAcademicEmpiricalReadiness({
    bubblewrapProbe: { available: true, backend: 'bubblewrap' },
    datasetAccessTracer: path.join(root, 'missing-strace'),
  });
  assert.equal(missingTracer.academicEmpiricalReady, false);
  assert.equal(
    missingTracer.academicEmpiricalReadinessReason,
    'academic_empirical_dataset_access_tracer_unavailable',
  );

  const ready = evaluateAcademicEmpiricalReadiness({
    bubblewrapProbe: { available: true, backend: 'bubblewrap' },
    datasetAccessTracer: tracer,
  });
  assert.equal(ready.academicEmpiricalReady, true);
  assert.equal(
    ready.academicEmpiricalDatasetProofBackend,
    'bubblewrap-host-supervised-strace-v2',
  );

  const dockerSupervisorFailed = evaluateAcademicEmpiricalReadiness({
    bubblewrapProbe: { available: true, backend: 'bubblewrap' },
    datasetAccessTracer: tracer,
    dockerSupervisorProbe: {
      available: false,
      backend: null,
      detail: 'trusted_dataset_supervisor_image_digest_mismatch',
    },
  });
  assert.equal(dockerSupervisorFailed.academicEmpiricalReady, false);
  assert.equal(dockerSupervisorFailed.academicEmpiricalDatasetProofBackend, null);
  assert.equal(
    dockerSupervisorFailed.academicEmpiricalReadinessReason,
    'trusted_dataset_supervisor_image_digest_mismatch',
  );

  const dockerSupervisorReady = evaluateAcademicEmpiricalReadiness({
    bubblewrapProbe: { available: true, backend: 'bubblewrap' },
    datasetAccessTracer: tracer,
    dockerSupervisorProbe: {
      available: true,
      backend: 'docker',
      detail: 'all_trusted_dataset_supervisors_end_to_end_verified',
    },
  });
  assert.equal(dockerSupervisorReady.academicEmpiricalReady, true);
  assert.equal(
    dockerSupervisorReady.academicEmpiricalDatasetProofBackend,
    'docker-trusted-container-supervisor-v1',
  );
});

test('sandbox Docker fallback uses the trusted fixed runtime image instead of Alpine', () => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const calls = [];
  let imageInspectionCount = 0;
  const probe = probeOsSandbox({
    refresh: true,
    dockerImage: 'alpine:3.20',
    trustedDatasetSupervisorImages: [trustedDatasetSupervisorProfile(runtime)],
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      if (executable === 'bwrap') {
        return { status: 1, stdout: '', stderr: 'bubblewrap unavailable' };
      }
      if (executable === 'which') return { status: 1, stdout: '', stderr: '' };
      if (executable === 'docker' && args[0] === 'image') {
        imageInspectionCount += 1;
        return imageInspectionCount === 1
          ? trustedDockerImageInspection(runtime)
          : { status: 1, stdout: '', stderr: 'supervisor image unavailable' };
      }
      if (executable === 'docker' && args[0] === 'info') {
        return { status: 0, stdout: '27.0.0\n', stderr: '' };
      }
      if (executable === 'docker' && args[0] === 'ps') {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected_sandbox_probe_command:${executable}:${args.join(' ')}`);
    },
  });
  assert.equal(probe.available, true);
  assert.equal(probe.backend, 'docker');
  assert.equal(probe.image, runtime.image);
  assert.equal(probe.academicEmpiricalReady, false);
  assert.equal(probe.dockerDatasetSupervisorReady, false);
  const inspectedImages = calls
    .filter(({ executable, args }) => executable === 'docker'
      && args[0] === 'image' && args[1] === 'inspect')
    .map(({ args }) => args[2]);
  assert.deepEqual(inspectedImages, [runtime.image, runtime.image]);
  assert.equal(calls.some(({ args }) => args.includes('alpine:3.20')), false);
});

test('available bubblewrap does not suppress the required Docker supervisor probe', {
  skip: typeof process.geteuid === 'function' && process.geteuid() === 0,
}, () => {
  const runtime = AUTOMATION_RUNTIME_IMAGES.python;
  const calls = [];
  const probe = probeOsSandbox({
    refresh: true,
    trustedDatasetSupervisorImages: [trustedDatasetSupervisorProfile(runtime)],
    environment: { PATH: process.env.PATH || '' },
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      if (executable === 'bwrap') return { status: 0, stdout: '', stderr: '' };
      if (executable === 'which') {
        return { status: 0, stdout: '/virtual/prlimit\n', stderr: '' };
      }
      if (executable === '/virtual/prlimit') {
        return { status: 0, stdout: '17 17\n', stderr: '' };
      }
      if (executable === 'docker' && args[0] === 'ps') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (executable === 'docker' && args[0] === 'image') {
        return { status: 1, stdout: '', stderr: 'supervisor image unavailable' };
      }
      throw new Error(`unexpected_sandbox_probe_command:${executable}:${args.join(' ')}`);
    },
  });
  assert.equal(probe.available, true);
  assert.equal(probe.backend, 'bubblewrap');
  assert.equal(probe.academicEmpiricalReady, false);
  assert.equal(probe.dockerDatasetSupervisorReady, false);
  assert.ok(calls.some(({ executable, args }) => (
    executable === 'docker' && args[0] === 'ps'
  )));
  assert.ok(calls.some(({ executable, args }) => (
    executable === 'docker' && args[0] === 'image'
      && args[1] === 'inspect' && args[2] === runtime.image
  )));
  assert.equal(calls.some(({ executable, args }) => (
    executable === 'docker' && args[0] === 'info'
  )), false);
});

test('campaign worker pins Docker readiness to its selected Python runtime profile', () => {
  const cpu = buildCampaignWorkerRuntimeImageConfiguration();
  assert.equal(cpu.dockerImage, AUTOMATION_RUNTIME_IMAGES.python.image);
  assert.ok(cpu.allowedContainerImages.includes(cpu.dockerImage));
  assert.ok(cpu.trustedDatasetSupervisorImages.some((profile) => (
    profile.image === cpu.dockerImage
      && profile.imageDigest === AUTOMATION_RUNTIME_IMAGES.python.imageDigest
  )));

  const gpu = buildCampaignWorkerRuntimeImageConfiguration({ requiresGpu: true });
  assert.equal(gpu.dockerImage, AUTOMATION_RUNTIME_IMAGES.pythonGpu.image);
  assert.ok(gpu.allowedContainerImages.includes(gpu.dockerImage));
});

test('campaign worker prepares private artifact and attempt workspace roots', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-artifacts-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const artifactRoot = prepareCampaignAutomationArtifactRoot(runtimeRoot);
  const artifactIdentity = fs.lstatSync(artifactRoot);
  assert.equal(artifactRoot, path.join(runtimeRoot, 'automation-artifacts'));
  assert.equal(artifactIdentity.isDirectory(), true);
  assert.equal(artifactIdentity.isSymbolicLink(), false);
  assert.equal(artifactIdentity.mode & 0o777, 0o700);

  const sourceWorkspace = path.join(runtimeRoot, 'source-paper');
  fs.mkdirSync(sourceWorkspace);
  const attemptRoot = prepareCampaignAttemptWorkspaceRoot(runtimeRoot);
  const attemptIdentity = fs.lstatSync(attemptRoot);
  assert.equal(attemptRoot, path.join(runtimeRoot, 'campaign-attempt-workspaces'));
  assert.equal(attemptIdentity.isDirectory(), true);
  assert.equal(attemptIdentity.isSymbolicLink(), false);
  assert.equal(attemptIdentity.mode & 0o777, 0o700);
  assert.deepEqual(buildCampaignWorkerAllowedRoots({
    plans: [{ sourceWorkspace }],
    runtimeRoot,
  }), [sourceWorkspace, attemptRoot]);
});

test('campaign smoke uses the production empirical runtime composition', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../bin/automation-campaign-smoke.mjs'),
    'utf8',
  );
  assert.match(source, /composeCampaignWorkerEmpiricalExecution\(\{/);
  assert.match(source, /createIsolatedAgentExecutor\(\{/);
  assert.match(source, /HEPTA_SMOKE_MAX_ROUNDS/);
  assert.doesNotMatch(source, /createMultiLanguageEmpiricalExecutor\(\{ workerRunner \}\)/);
});

test('Codex agent adapter executes a real process and records workspace changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agent-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, 'codex-shim.sh');
  fs.writeFileSync(
    shim,
    '#!/bin/sh\ncat >/dev/null\nprintf "changed\\n" > agent-output.txt\nprintf \'{"status":"completed","summary":"ok","checksRun":[],"blockers":[]}\\n\'\n',
  );
  fs.chmodSync(shim, 0o755);
  const executor = createCodexAgentExecutor({ codexBinary: shim, timeoutMs: 5000 });
  const receipt = await executor.execute({
    role: 'writer',
    workspacePath: root,
    instructions: 'write a fixture',
    sandbox: 'workspace-write',
  });
  assert.equal(receipt.status, 'agent_execution_completed');
  assert.deepEqual(receipt.changedPaths, ['agent-output.txt']);
  assert.equal(receipt.externalActionPerformed, false);
});
