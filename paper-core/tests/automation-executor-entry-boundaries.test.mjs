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
  createOsSandboxedWorkerRunner,
  fileSha256Hash,
} from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  buildCampaignAgentInstructions,
  buildCampaignAgentExecutionRequest,
  buildFormalProofRepairRequest,
} from '../../paper-application/automation/campaign-agent-policy.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
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
});

test('formal author contract requires source types canonical with kernel check output', () => {
  const instructions = buildCampaignAgentInstructions({
    kind: 'formal-author', manuscript: 'main.tex',
  });
  assert.match(instructions, /explicit '∀ \(\.\.\.\)' form/);
  assert.match(instructions, /'Nat\.min', never bare 'min'/);
  assert.match(instructions, /SYSTEM_ALLOWED_FORMAL_AXIOMS=\[\]/);
  assert.match(instructions, /expanding 'Nat\.min_def'/);
  assert.match(instructions, /rather than using 'Nat\.min_le_left' or 'Nat\.min_le_right'/);
  assert.match(instructions, /change \(if loss ≤ cap then loss else cap\) ≤ cap/);
  assert.match(instructions, /RESEARCH_WORKER_PLAN\.json.*system-finalized after your turn/);
  assert.match(instructions, /do not calculate or self-author their SHA-256 values/);
});

test('formal author and repair execution requests pin the kernel-audited loss-cap proof', () => {
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
  for (const request of [author, repair]) {
    assert.match(request.instructions, /use this already kernel-audited declaration verbatim/);
    assert.match(request.instructions, /theorem loss_cap_upper_bound : ∀ \(loss cap : Nat\), Nat\.min loss cap ≤ cap := by/);
    assert.match(request.instructions, /change \(if loss ≤ cap then loss else cap\) ≤ cap/);
    assert.match(request.instructions, /Do not replace its change step with rw, simp, omega/);
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
