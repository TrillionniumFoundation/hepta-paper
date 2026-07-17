import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { restrictedChildEnvironment } from '../../paper-adapters/automation/bounded-child-process.mjs';
import {
  inspectDockerRuntimeImageManifest,
} from '../../paper-adapters/automation/docker-runtime-image-manifest-inspection.mjs';
import { probeOsSandbox } from '../bootstrap/operator-runtime-composition.mjs';
import {
  AUTOMATION_RUNTIME_IMAGES,
  preflightCodexFormalReviewer,
  preflightCodexResearchAuthor,
  probeCodexModelAvailability,
} from '../bootstrap/operator-automation-composition.mjs';
import { PRODUCTION_LEAN_TOOLCHAIN } from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const LOCAL_DOCKER_HOST = 'unix:///var/run/docker.sock';

function configuredEndpointLocality(value) {
  if (!value) return Object.freeze({ configured: false, local: null, remote: null });
  try {
    const hostname = new URL(String(value)).hostname.replace(/^\[|\]$/g, '');
    const local = ['127.0.0.1', '::1', 'localhost'].includes(hostname);
    return Object.freeze({ configured: true, local, remote: !local });
  } catch {
    return Object.freeze({ configured: true, local: false, remote: true });
  }
}

function readinessOperation(executable, args, scope) {
  const name = path.basename(String(executable || '')).toLowerCase();
  if (name === 'docker') {
    if (args[0] === 'run') return 'docker_container_probe';
    if (args[0] === 'rm' && args.includes('--force')) return 'docker_container_cleanup';
    if (args[0] === 'container' && args[1] === 'inspect') {
      return 'docker_container_inspection';
    }
    if (args[0] === 'ps' && args.includes('--filter')) {
      return 'docker_container_reconciliation';
    }
    if (args[0] === 'image' && args[1] === 'inspect') return 'docker_image_inspection';
    if (args[0] === 'info') return 'docker_daemon_status';
    return 'docker_daemon_command';
  }
  if (name === 'which') return 'executable_discovery';
  if (name === 'openclaw') return 'openclaw_local_runtime_status';
  if (name === 'ollama') return 'ollama_local_runtime_status';
  if (args[0] === 'login' && args[1] === 'status') return 'credential_status';
  if (name.includes('codex') && args[0] === 'exec' && !args.includes('--help')) {
    return 'provider_model_canary';
  }
  if (scope === 'release-attestor') return 'release_attestor_backend_process';
  if (scope === 'runtime-sandbox') return 'sandbox_runtime_probe';
  return 'runtime_process_probe';
}

function actionEndpointLocality(operation, environment) {
  if (operation.startsWith('docker_')) return 'local_unix_daemon';
  if (operation === 'openclaw_local_runtime_status') {
    return configuredEndpointLocality(environment.OPENCLAW_GATEWAY_URL).remote
      ? 'remote_endpoint' : 'local_endpoint';
  }
  if (operation === 'ollama_local_runtime_status') {
    return configuredEndpointLocality(environment.OLLAMA_HOST).remote
      ? 'remote_endpoint' : 'local_endpoint';
  }
  if (operation === 'provider_model_canary') return 'external_provider';
  if (operation === 'release_attestor_backend_process') return 'external_release_backend';
  return 'local_process';
}

export function createAutomationReadinessSideEffectLedger({
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const actions = [];
  const dockerContextConfigured = Boolean(environment.DOCKER_CONTEXT);
  const configuredDockerHost = String(environment.DOCKER_HOST || '');
  const dockerEndpointPermitted = !dockerContextConfigured
    && (!configuredDockerHost || configuredDockerHost === LOCAL_DOCKER_HOST);
  const endpointBlockers = Object.freeze(dockerEndpointPermitted
    ? [] : ['automation_readiness_remote_docker_endpoint_forbidden']);
  const baseEnvironment = restrictedChildEnvironment({ source: environment });

  const inspection = ({ releaseAttestorInspection = null, failureCode = null } = {}) => {
    const operations = [...new Set(actions.map((action) => action.operation))].sort();
    const operationCounts = Object.freeze(Object.fromEntries(operations.map((operation) => [
      operation,
      actions.filter((action) => action.operation === operation).length,
    ])));
    const dockerDaemonActionCount = actions.filter((action) =>
      action.operation.startsWith('docker_')).length;
    const externalEndpointActionCount = actions.filter((action) =>
      ['external_provider', 'external_release_backend', 'remote_endpoint']
        .includes(action.endpointLocality)).length;
    const blockers = Object.freeze([...new Set([
      ...endpointBlockers,
      ...(failureCode ? [`automation_readiness_failed:${failureCode}`] : []),
    ])]);
    const payload = Object.freeze({
      version: 1,
      kind: 'AutomationReadinessSideEffectInspection',
      status: blockers.length
        ? 'automation_readiness_side_effect_inspection_failed'
        : 'automation_readiness_side_effect_inspection_recorded',
      controlledChildEnvironment: true,
      endpointLocality: Object.freeze({
        docker: Object.freeze({
          configuredHostPresent: Boolean(configuredDockerHost),
          contextConfigured: dockerContextConfigured,
          effectiveHostKind: 'local_unix_socket',
          local: dockerEndpointPermitted,
          remote: !dockerEndpointPermitted,
        }),
        openclaw: configuredEndpointLocality(environment.OPENCLAW_GATEWAY_URL),
        ollama: configuredEndpointLocality(environment.OLLAMA_HOST),
      }),
      processActionCount: actions.length,
      successfulProcessActionCount: actions.filter((action) => action.succeeded).length,
      failedProcessActionCount: actions.filter((action) => !action.succeeded).length,
      credentialStatusActionCount: operationCounts.credential_status || 0,
      dockerDaemonActionCount,
      dockerContainerActionCount: actions.filter((action) =>
        action.operation.startsWith('docker_container_')).length,
      providerCanaryActionCount: operationCounts.provider_model_canary || 0,
      releaseAttestorProcessActionCount:
        operationCounts.release_attestor_backend_process || 0,
      releaseAttestorBackendProbeActionCount:
        releaseAttestorInspection?.backendProbeExternalActionAttempted === true ? 1 : 0,
      releaseAttestorSignerChallengeActionCount:
        releaseAttestorInspection?.activeSignerChallengeExternalActionAttempted === true ? 1 : 0,
      releaseAttestorInspectionHash:
        releaseAttestorInspection
          ?.researchExecutionReleaseAttestorConfigurationInspectionHash || null,
      localProcessActionPerformed: actions.some((action) =>
        action.endpointLocality === 'local_process'),
      localDaemonActionPerformed: dockerDaemonActionCount > 0,
      externalEndpointActionPerformed: externalEndpointActionCount > 0,
      externalEndpointActionCount,
      externalActionPerformed: actions.length > 0,
      externalActionScope: actions.length > 0 ? operations.join(',') : 'none',
      operationCounts,
      actions: Object.freeze(actions.map((action) => Object.freeze({ ...action }))),
      blockers,
    });
    return Object.freeze({
      ...payload,
      automationReadinessSideEffectInspectionHash: hashRecord(
        'AutomationReadinessSideEffectInspection', payload,
      ),
    });
  };

  const attachFailureInspection = (error, options = {}) => {
    const failure = error instanceof Error ? error : new Error(String(error || 'unknown_error'));
    failure.automationReadinessSideEffectInspection = inspection({
      ...options,
      failureCode: String(failure.message || 'unknown_error').slice(0, 512),
    });
    return failure;
  };
  const assertEndpointPolicy = () => {
    if (!dockerEndpointPermitted) {
      throw attachFailureInspection(new Error(
        'automation_readiness_remote_docker_endpoint_forbidden',
      ));
    }
  };
  const spawnSyncFor = (scope) => (executable, args = [], options = {}) => {
    assertEndpointPolicy();
    const operation = readinessOperation(executable, args, scope);
    const childEnvironment = options.env ? { ...options.env } : { ...baseEnvironment };
    if (childEnvironment.DOCKER_CONTEXT
      || (childEnvironment.DOCKER_HOST
        && childEnvironment.DOCKER_HOST !== LOCAL_DOCKER_HOST)) {
      throw attachFailureInspection(new Error(
        'automation_readiness_child_remote_docker_endpoint_forbidden',
      ));
    }
    if (operation.startsWith('docker_')) {
      childEnvironment.DOCKER_HOST = LOCAL_DOCKER_HOST;
      delete childEnvironment.DOCKER_CONTEXT;
    }
    const draft = {
      sequence: actions.length + 1,
      scope,
      executable: path.basename(String(executable || '')),
      operation,
      endpointLocality: actionEndpointLocality(operation, environment),
      succeeded: false,
      exitCode: null,
      signal: null,
      errorCode: null,
    };
    actions.push(draft);
    try {
      const result = spawnSyncImpl(executable, args, { ...options, env: childEnvironment });
      draft.succeeded = result?.status === 0 && !result?.error && !result?.signal;
      draft.exitCode = Number.isInteger(result?.status) ? result.status : null;
      draft.signal = result?.signal ? String(result.signal) : null;
      draft.errorCode = result?.error?.code ? String(result.error.code) : null;
      return result;
    } catch (error) {
      draft.errorCode = String(error?.code || error?.message || 'spawn_failed').slice(0, 160);
      throw error;
    }
  };
  return Object.freeze({
    assertEndpointPolicy, attachFailureInspection, inspection, spawnSyncFor,
  });
}

function probeCommand({ name, args = ['--version'], env = {}, spawnSyncImpl, environment }) {
  const childEnvironment = restrictedChildEnvironment({ source: environment, overrides: env });
  let executable = null;
  if (String(name).includes(path.sep)) {
    try {
      executable = fs.realpathSync(path.resolve(name));
      fs.accessSync(executable, fs.constants.X_OK);
    } catch { executable = null; }
  } else {
    const located = spawnSyncImpl('which', [name], {
      encoding: 'utf8', timeout: 3000, env: { ...childEnvironment },
    });
    if (located.status === 0) executable = String(located.stdout || '').trim();
  }
  if (!executable) return { present: false, executable: null, usable: false };
  const probe = spawnSyncImpl(executable, args, {
    encoding: 'utf8', timeout: 10000, env: { ...childEnvironment },
  });
  return {
    present: true,
    executable,
    usable: probe.status === 0,
    detail: String(probe.stdout || probe.stderr || '').trim().split(/\n/)[0] || null,
    ...(env.ELAN_TOOLCHAIN ? { toolchain: env.ELAN_TOOLCHAIN } : {}),
  };
}

function privateCodexHomeReady(candidate) {
  if (!candidate) return false;
  try {
    const requested = path.resolve(candidate);
    const requestedStat = fs.lstatSync(requested);
    if (requestedStat.isSymbolicLink()) return false;
    const root = fs.realpathSync(requested);
    if (root !== requested) return false;
    const rootStat = fs.lstatSync(root);
    const configStat = fs.lstatSync(path.join(root, 'config.toml'));
    const uid = typeof process.getuid === 'function' ? process.getuid() : rootStat.uid;
    return rootStat.isDirectory() && configStat.isFile()
      && rootStat.uid === uid && configStat.uid === uid
      && !rootStat.isSymbolicLink() && !configStat.isSymbolicLink()
      && (rootStat.mode & 0o077) === 0 && (configStat.mode & 0o077) === 0;
  } catch { return false; }
}

function codexLoginReady({ codexHome, codexBinary, spawnSyncImpl, environment }) {
  if (!codexHome) return false;
  const probe = spawnSyncImpl(codexBinary, ['login', 'status'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...restrictedChildEnvironment({
      source: environment,
      allowedKeys: ['CODEX_HOME'],
      overrides: { CODEX_HOME: codexHome },
    }) },
  });
  const text = String(probe.stdout || probe.stderr || '');
  return probe.status === 0 && /(?:logged\s+in|authenticated)/i.test(text)
    && !/not\s+logged\s+in/i.test(text);
}

function codexHomesDistinct(left, right) {
  if (!left || !right) return false;
  try { return fs.realpathSync(path.resolve(left)) !== fs.realpathSync(path.resolve(right)); }
  catch { return false; }
}

export function buildAutomationRuntimeProbes({ configuration, spawnSyncImpl, environment }) {
  const command = (name, args = ['--version'], env = {}) => probeCommand({
    name, args, env, spawnSyncImpl, environment,
  });
  const image = (candidate) => {
    const inspection = inspectDockerRuntimeImageManifest({
      image: candidate.image,
      expectedManifestDigest: candidate.imageDigest,
      spawnSyncImpl,
      environment,
    });
    return {
      image: candidate.image,
      expectedDigest: candidate.imageDigest,
      observedDigest: inspection.observedManifestDigest,
      exactDigestVerified: inspection.ready,
      present: inspection.present,
      usable: inspection.ready,
      buildReproducibility: candidate.buildReproducibility,
      manifestInspection: inspection,
    };
  };
  const trustedDatasetSupervisorImages = [AUTOMATION_RUNTIME_IMAGES.python, AUTOMATION_RUNTIME_IMAGES.r]
    .map((item) => ({
      image: item.image,
      imageDigest: item.imageDigest,
      containerExecutable: item.executable,
      supervisor: item.datasetAccessSupervisor,
    }));
  const sandboxProbe = probeOsSandbox({
    refresh: true, trustedDatasetSupervisorImages, spawnSyncImpl, environment,
  });
  const runtimes = {
    codex: command(configuration.researchAuthorCodexBinary),
    python: command('python3'),
    node: command('node'),
    r: command('Rscript'),
    julia: command('julia'),
    lean: command('lake', ['--version'], { ELAN_TOOLCHAIN: PRODUCTION_LEAN_TOOLCHAIN }),
    latex: command('latexmk', ['-version']),
    sandbox: { ...sandboxProbe, present: true, usable: sandboxProbe.available },
    gpu: command('nvidia-smi', ['-L']),
    images: {
      python: image(AUTOMATION_RUNTIME_IMAGES.python),
      pythonGpu: image(AUTOMATION_RUNTIME_IMAGES.pythonGpu),
      r: image(AUTOMATION_RUNTIME_IMAGES.r),
    },
  };
  const gpuContainerProbe = runtimes.gpu.usable && runtimes.images.pythonGpu.usable
    ? spawnSyncImpl('docker', [
      'run', '--pull', 'never', '--rm', '--runtime', 'nvidia',
      '--env', 'NVIDIA_VISIBLE_DEVICES=all',
      '--env', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility',
      '--env', 'HOME=/tmp', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
      'python', '-c', 'import cupy as cp; x=cp.arange(32); assert int(cp.asnumpy((x*x)[17])) == 289; assert cp.cuda.runtime.getDeviceCount() > 0',
    ], {
      encoding: 'utf8', timeout: 30000,
      env: { ...restrictedChildEnvironment({
        source: environment, overrides: { DOCKER_HOST: LOCAL_DOCKER_HOST },
      }) },
    }) : null;
  runtimes.gpuContainer = {
    present: runtimes.images.pythonGpu.present,
    usable: gpuContainerProbe?.status === 0,
    detail: gpuContainerProbe
      ? String(gpuContainerProbe.stderr || gpuContainerProbe.error?.message || '')
        .trim().slice(-1000) || 'cupy_cuda_probe_passed'
      : 'gpu_image_or_host_gpu_unavailable',
  };
  runtimes.images.pythonGpu.usable = runtimes.images.pythonGpu.exactDigestVerified
    && runtimes.gpuContainer.usable;
  return runtimes;
}

function jsonContainsAgent(value, expectedId) {
  if (Array.isArray(value)) return value.some((item) => jsonContainsAgent(item, expectedId));
  if (!value || typeof value !== 'object') return false;
  if ([value.id, value.agentId, value.agent_id, value.name]
    .some((item) => item === expectedId)) return true;
  return Object.values(value).some((item) => jsonContainsAgent(item, expectedId));
}

export function inspectAutomationAgentProviders({
  runtimes,
  configuration,
  liveProviderCanaryRequested,
  spawnSyncImpl,
  environment,
  canaryClock,
  legacyAgentFallbackProbesRequested = false,
}) {
  const legacyEndpointPolicyReady = !configuredEndpointLocality(environment.OLLAMA_HOST).remote
    && !configuredEndpointLocality(environment.OPENCLAW_GATEWAY_URL).remote;
  const legacyEnvironment = restrictedChildEnvironment({
    source: environment, allowedKeys: ['OLLAMA_HOST', 'OPENCLAW_GATEWAY_URL'],
  });
  const legacyProbesEnabled = legacyAgentFallbackProbesRequested
    && legacyEndpointPolicyReady;
  const invokeLegacy = (executable, args, timeout) => legacyProbesEnabled
    ? spawnSyncImpl(executable, args, {
      encoding: 'utf8', timeout, env: { ...legacyEnvironment },
    }) : { status: null, stdout: '', stderr: '' };
  const ollamaTags = invokeLegacy('ollama', ['list'], 5000);
  const openclawHealth = invokeLegacy('openclaw', ['gateway', 'health', '--json'], 10000);
  const openclawAgents = invokeLegacy('openclaw', ['agents', 'list', '--json'], 15000);
  const agentOutput = String(openclawAgents.stdout || '');
  let parsedAgents = null;
  try { parsedAgents = JSON.parse(agentOutput || '{}'); } catch { parsedAgents = null; }
  const containsAgent = (id) => Boolean(id && (parsedAgents
    ? jsonContainsAgent(parsedAgents, id)
    : agentOutput.includes(`"${id}"`)));
  const heptaWorkerConfigured = containsAgent('hepta-paper-worker');
  const formalReviewAgentConfigured = configuration.formalReviewAgentId
    !== 'hepta-paper-worker' && containsAgent(configuration.formalReviewAgentId);
  const localAgentModels = String(ollamaTags.stdout || '').split(/\n/).slice(1)
    .map((line) => line.trim().split(/\s+/)[0]).filter((name) => name && !/embed/i.test(name));
  const researchAuthorHomeReady = privateCodexHomeReady(configuration.researchAuthorCodexHome);
  const researchAuthorAuthenticated = researchAuthorHomeReady && codexLoginReady({
    codexHome: configuration.researchAuthorCodexHome,
    codexBinary: configuration.researchAuthorCodexBinary,
    spawnSyncImpl,
    environment,
  });
  let researchAuthorPreflight = null;
  let researchAuthorPreflightBlocker = null;
  try {
    researchAuthorPreflight = preflightCodexResearchAuthor({
      codexBinary: configuration.researchAuthorCodexBinary,
      codexHome: configuration.researchAuthorCodexHome,
      model: configuration.researchAuthorModel,
      spawnSyncImpl,
      environment,
    });
  } catch (error) {
    researchAuthorPreflightBlocker = error?.message || 'research_author_codex_preflight_failed';
  }
  const openAiLoggedIn = researchAuthorAuthenticated
    && researchAuthorPreflight?.capabilityReceipt?.authenticationStatus
      === 'codex_authentication_verified';
  let researchAuthorModelCanary = null;
  let researchAuthorModelCanaryBlocker = null;
  if (liveProviderCanaryRequested && researchAuthorPreflight) {
    try {
      researchAuthorModelCanary = probeCodexModelAvailability({
        codexBinary: configuration.researchAuthorCodexBinary,
        codexHome: configuration.researchAuthorCodexHome,
        model: configuration.researchAuthorModel,
        errorPrefix: 'research_author_codex',
        spawnSyncImpl,
        environment,
        clock: canaryClock,
      });
    } catch (error) {
      researchAuthorModelCanaryBlocker =
        error?.message || 'research_author_codex_model_live_canary_failed';
    }
  }
  const formalReviewHomeReady = privateCodexHomeReady(configuration.formalReviewCodexHome);
  const formalReviewAuthenticated = formalReviewHomeReady && codexLoginReady({
    codexHome: configuration.formalReviewCodexHome,
    codexBinary: configuration.formalReviewCodexBinary,
    spawnSyncImpl,
    environment,
  });
  const formalReviewCredentialRootDistinct = formalReviewHomeReady
    && researchAuthorHomeReady && codexHomesDistinct(
      configuration.formalReviewCodexHome, configuration.researchAuthorCodexHome,
    );
  let formalReviewPreflight = null;
  let formalReviewPreflightBlocker = null;
  if (configuration.formalReviewProvider === 'codex') {
    try {
      formalReviewPreflight = preflightCodexFormalReviewer({
        codexBinary: configuration.formalReviewCodexBinary,
        codexHome: configuration.formalReviewCodexHome,
        model: configuration.formalReviewModel,
        authorProvider: 'codex',
        authorCodexHome: configuration.researchAuthorCodexHome,
        spawnSyncImpl,
        environment,
      });
    } catch (error) {
      formalReviewPreflightBlocker = error?.message || 'formal_review_codex_preflight_failed';
    }
  } else formalReviewPreflightBlocker = 'full_research_formal_review_provider_must_be_codex';
  let formalReviewModelCanary = null;
  let formalReviewModelCanaryBlocker = null;
  if (liveProviderCanaryRequested && formalReviewPreflight) {
    try {
      formalReviewModelCanary = probeCodexModelAvailability({
        codexBinary: configuration.formalReviewCodexBinary,
        codexHome: configuration.formalReviewCodexHome,
        model: configuration.formalReviewModel,
        errorPrefix: 'formal_review_codex',
        spawnSyncImpl,
        environment,
        clock: canaryClock,
      });
    } catch (error) {
      formalReviewModelCanaryBlocker =
        error?.message || 'formal_review_codex_model_live_canary_failed';
    }
  }
  const researchAuthorBlockers = researchAuthorPreflight
    ? (researchAuthorModelCanary ? [] : [researchAuthorModelCanaryBlocker
      || 'research_author_codex_model_live_canary_not_requested'])
    : [researchAuthorPreflightBlocker];
  const formalReviewBlockers = formalReviewPreflight
    ? (formalReviewModelCanary ? [] : [formalReviewModelCanaryBlocker
      || 'formal_review_codex_model_live_canary_not_requested'])
    : [formalReviewPreflightBlocker];
  runtimes.agent = {
    usable: openclawHealth.status === 0 || openAiLoggedIn || localAgentModels.length > 0,
    defaultProvider: 'openclaw',
    draftDefaultProvider: 'openclaw-with-local-fallback',
    researchDefaultProvider: 'codex',
    defaultBackendReady: openclawHealth.status === 0 && heptaWorkerConfigured,
    fallbackReady: openAiLoggedIn || localAgentModels.length > 0,
    researchAuthorConfigurationPreflightReady: Boolean(researchAuthorPreflight),
    researchAuthorProviderAvailable: Boolean(researchAuthorModelCanary),
    researchAuthorAssuranceScope:
      researchAuthorPreflight?.capabilityReceipt?.assuranceScope || 'not_verified',
    researchAuthorModelConfigured: Boolean(configuration.researchAuthorModel),
    researchAuthorCodexHomeConfigured: Boolean(configuration.researchAuthorCodexHome),
    researchAuthorCredentialHomePrivate: researchAuthorHomeReady,
    researchAuthorAuthenticated,
    researchAuthorBlockers,
    researchAuthorModelCanaryReceipt: researchAuthorModelCanary,
    openclawGatewayReady: openclawHealth.status === 0,
    heptaWorkerConfigured,
    formalReviewAgentId: configuration.formalReviewAgentId,
    formalReviewAgentConfigured,
    formalReviewProvider: configuration.formalReviewProvider,
    formalReviewConfigurationIndependentPrincipalReady:
      configuration.formalReviewProvider === 'codex' && Boolean(formalReviewPreflight),
    formalReviewProviderAvailable: Boolean(formalReviewModelCanary),
    formalReviewIndependentPrincipalReady: configuration.formalReviewProvider === 'codex'
      && Boolean(formalReviewPreflight && formalReviewModelCanary),
    formalReviewModelConfigured: Boolean(configuration.formalReviewModel),
    formalReviewCodexHomeConfigured: Boolean(configuration.formalReviewCodexHome),
    formalReviewCredentialHomePrivate: formalReviewHomeReady,
    formalReviewAuthenticated,
    formalReviewCredentialRootDistinct,
    formalReviewBlockers,
    formalReviewModelCanaryReceipt: formalReviewModelCanary,
    formalReviewAssuranceScope:
      formalReviewPreflight?.capabilityReceipt?.assuranceScope || 'not_verified',
    formalReviewProviderAccountIndependenceVerified: false,
    formalReviewOpenClawAttemptIsolationCompatible: false,
    openAiLoggedIn,
    localModels: localAgentModels,
    legacyAgentFallbackProbesRequested,
    legacyAgentFallbackProbesPerformed: legacyProbesEnabled,
    legacyAgentFallbackEndpointPolicyReady: legacyEndpointPolicyReady,
  };
  return {
    researchAuthorPreflight,
    researchAuthorModelCanary,
    formalReviewPreflight,
    formalReviewModelCanary,
  };
}
