import path from 'node:path';
import { assertFormalVerifierPort } from '../../paper-ports/formal-verifier-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateFormalClaimBindings } from '../../paper-domain/research/formal-claim-binding-policy.mjs';
import { PRODUCTION_LEAN_TOOLCHAIN } from '../../paper-domain/research/formal-verifier-policy.mjs';
import { normalizeFormalProofObligationMappings } from '../../paper-domain/research/formal-proof-obligation-mapping.mjs';
import {
  dynamicFormalLeanTypeSourceValid,
} from '../../paper-domain/research/dynamic-formal-claim-seed-contract.mjs';
import { leanTypeIdentity } from '../../paper-domain/research/lean-type-identity.mjs';
import {
  autonomousFormalLeanTypeContractForObligation,
  autonomousFormalTypeAuditForObligation,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  analyzeLeanTypeContract,
  leanSourceDeclarationRecords,
  leanSourceImports,
} from './lean-source-contracts.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { createFormalProjectSnapshotRepository } from './formal-project-snapshot-repository.mjs';
import { readFormalProjectClosure } from './formal-project-closure-reader.mjs';
import {
  extractLeanReadableProofAudits,
  leanReadableProofAuditSetHash,
  readableProofAuditDirectives,
} from './lean-readable-proof-audit.mjs';

function projectManifestHash(projectFiles) {
  return hashRecord('FormalProjectManifest', projectFiles.map(({ path: filePath, sourcePath, projectPath, role, hash, bytes, posixMode }) => ({ path: filePath, sourcePath: sourcePath || filePath, projectPath: projectPath ?? filePath, role: role || 'project', hash, bytes, posixMode })));
}

function projectFile(projectFiles, relative) {
  return projectFiles.find((file) => (file.projectPath ?? file.path) === relative) || null;
}

function executableProjectFiles(projectFiles, { requireImmutableExecutionClosure }) {
  if (requireImmutableExecutionClosure) return projectFiles;
  return projectFiles.filter((file) => {
    const projectPath = file.projectPath ?? file.path;
    return !/^\.lake\/(?:build\/|(?!packages\/))/.test(String(projectPath || ''));
  });
}

function safeSourceFile(sourceFile) {
  const relative = String(sourceFile || '').replace(/\\/g, '/');
  if (!relative.endsWith('.lean') || relative.startsWith('/') || relative.split('/').includes('..')) return null;
  return relative;
}

function safeTheoremName(value) {
  const name = String(value || '');
  return /^[A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(name) ? name : null;
}

function canonicalAuditPlan(claimBindings) {
  const bySource = new Map();
  for (const claim of claimBindings) {
    const sourceFile = safeSourceFile(claim.sourceFile);
    const theoremName = safeTheoremName(claim.theoremName);
    const dynamicAuthority = claim?.formalClaimContract?.dynamicFormalClaimAuthority || null;
    const obligationMapping = normalizeFormalProofObligationMappings({
      proofObligationContracts: claim.proofObligationContracts,
      proofObligations: claim.proofObligations || claim.obligationNames,
      proofObligationMappings: claim.proofObligationMappings,
      theoremName,
    });
    if (!sourceFile || !theoremName || !obligationMapping.valid) return null;
    if (dynamicAuthority && (
      dynamicAuthority.leanDeclarationName !== theoremName
      || !dynamicFormalLeanTypeSourceValid(dynamicAuthority.leanTypeSource)
      || dynamicAuthority.leanTypeSourceHash
        !== hashBytes(Buffer.from(dynamicAuthority.leanTypeSource, 'utf8'))
      || dynamicAuthority.leanNormalizedTypeHash
        !== leanTypeIdentity(dynamicAuthority.leanTypeSource).normalizedTypeHash
      || claim.expectedTypeHash !== dynamicAuthority.leanNormalizedTypeHash
      || claim.formalClaimContract?.theoremName !== theoremName
      || claim.formalClaimContract?.theoremTypeHash !== dynamicAuthority.leanNormalizedTypeHash
    )) return null;
    if (!bySource.has(sourceFile)) bySource.set(sourceFile, {
      names: new Set(),
      typeAuditsByName: new Map(),
    });
    const sourceAudit = bySource.get(sourceFile);
    sourceAudit.names.add(theoremName);
    if (dynamicAuthority) {
      const dynamicTypeAudit = `#check (${theoremName} : ${dynamicAuthority.leanTypeSource})`;
      const existing = sourceAudit.typeAuditsByName.get(theoremName);
      if (existing && existing !== dynamicTypeAudit) return null;
      sourceAudit.typeAuditsByName.set(theoremName, dynamicTypeAudit);
    }
    for (const declarationName of obligationMapping.verificationTargets) {
      sourceAudit.names.add(declarationName);
    }
    for (const mapping of obligationMapping.mappings) {
      for (const declarationName of mapping.leanDeclarations) {
        const typeAudit = dynamicAuthority ? null : autonomousFormalTypeAuditForObligation({
          proofObligation: mapping.displayText,
          theoremName: declarationName,
        });
        if (typeAudit) {
          const existing = sourceAudit.typeAuditsByName.get(declarationName);
          if (existing && existing !== typeAudit) return null;
          sourceAudit.typeAuditsByName.set(declarationName, typeAudit);
        }
      }
    }
  }
  if (!bySource.size) return null;
  const entries = [...bySource.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([sourceFile, sourceAudit]) => {
    const theoremNames = [...sourceAudit.names].sort();
    const typeAudits = [...sourceAudit.typeAuditsByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.freeze({
      sourceFile,
      theoremNames,
      directives: [
        ...theoremNames
          .filter((name) => !sourceAudit.typeAuditsByName.has(name))
          .map((name) => `#check ${name}`),
        ...typeAudits.map(([, directive]) => directive),
        ...theoremNames.map((name) => `#print axioms ${name}`),
        readableProofAuditDirectives(theoremNames),
      ].join('\n'),
    });
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    canonicalSource: entries.map((entry) => `-- ${entry.sourceFile}\n${entry.directives}`).join('\n'),
  });
}

function pinnedToolchain(projectRoot, projectFiles) {
  const toolchain = projectFile(projectFiles, 'lean-toolchain');
  if (!toolchain) return null;
  const read = readScopedFileSync({ scopeRoot: projectRoot, candidate: path.join(projectRoot, 'lean-toolchain') });
  if (read.status !== 'scoped_file_read_verified' || read.hash !== toolchain.hash) return null;
  const value = read.content.toString('utf8').trim();
  return value === PRODUCTION_LEAN_TOOLCHAIN ? value : null;
}

function executionIdentity(receipt) {
  return Object.freeze({
    runnerId: receipt?.runnerId || null,
    backend: receipt?.backend || null,
    runtimeIdentityType: receipt?.runtimeIdentityType || null,
    runtimeIdentityHash: receipt?.runtimeIdentityHash || null,
    runtimeExecutableSnapshotHash: receipt?.runtimeExecutableSnapshotHash || null,
    runtimeExecutableInvocationPath: receipt?.runtimeExecutableInvocationPath || null,
    containerImageDigest: receipt?.containerImageDigest || null,
  });
}

function immutableClosureFiles(closure) {
  return (closure?.files || []).map((file) => ({
    sourcePath: file.sourcePath,
    projectPath: file.projectPath,
    role: file.role,
    hash: file.hash,
    bytes: file.bytes,
    posixMode: file.posixMode,
  }));
}

function combineImmutableAuditExecutions(executions) {
  if (executions.length === 1) return executions[0];
  const first = executions[0] || {};
  const identityFields = [
    'runnerId', 'backend', 'runtimeIdentityType', 'runtimeIdentityHash',
    'runtimeExecutableSnapshotHash', 'runtimeExecutableInvocationPath',
    'containerImageDigest',
  ];
  const identityMismatch = executions.some((execution) => identityFields.some((field) => (
    execution?.[field] !== first?.[field]
  )));
  const blockers = [
    ...executions.flatMap((execution) => execution?.blockers || []),
    ...(identityMismatch ? ['formal_immutable_audit_runtime_identity_mismatch'] : []),
  ];
  return {
    ...first,
    ok: executions.length > 0 && executions.every((execution) => execution?.ok === true)
      && !identityMismatch,
    stdout: executions.map((execution) => String(execution?.stdout || '')).join('\n'),
    stderr: executions.map((execution) => String(execution?.stderr || '')).join('\n'),
    blockers: [...new Set(blockers)],
    receiptHash: hashRecord('FormalImmutableAuditExecutionSet', executions.map((execution) => (
      execution?.receiptHash || null
    ))),
  };
}

function normalizedAuditOutputLine(value) {
  return String(value || '').trim().replace(/^(?:info|warning):\s+[^:]+:\d+:\d+:\s*/, '');
}

function declarationFromAudit(
  theoremName,
  execution,
  sourceDeclaration = null,
  verifiedObligationIds = [],
  expectedLeanTypeContract = null,
) {
  const stdout = String(execution?.stdout || '');
  const stderr = String(execution?.stderr || '');
  const outputLines = stdout.split(/\r?\n/);
  const checkLines = outputLines.filter((item) => {
    const value = normalizedAuditOutputLine(item);
    return value === theoremName || value.startsWith(`${theoremName} `) || value.startsWith(`${theoremName}:`);
  });
  const normalizedLine = checkLines.length === 1 ? normalizedAuditOutputLine(checkLines[0]) : '';
  const auditSignature = normalizedLine ? normalizedLine.slice(theoremName.length).replace(/^\s*:\s*/, '').trim() : '';
  const contract = analyzeLeanTypeContract(
    expectedLeanTypeContract?.expectedType || auditSignature,
  );
  const sourceTypeMatchesAudit = Boolean(sourceDeclaration?.typeHash && contract.typeHash
    && sourceDeclaration.typeHash === contract.typeHash);
  const axiomLines = outputLines.filter((item) => (
    item.includes(`'${theoremName}'`) && /axioms?/i.test(item)
  ));
  const axiomLine = axiomLines.length === 1 ? axiomLines[0] : '';
  const axiomAuditPresent = Boolean(axiomLines.length === 1
    && (/depends on axioms:/i.test(axiomLine) || /does not depend on any axioms/i.test(axiomLine)));
  const bracket = /\[([^\]]*)\]/.exec(axiomLine);
  const axioms = bracket ? bracket[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
  return {
    name: theoremName,
    typeHash: contract.typeHash || null,
    normalizedType: contract.normalizedType || null,
    premises: contract.premises || [],
    conclusion: contract.conclusion || null,
    sourceStatementHash: sourceDeclaration?.statementHash || null,
    buildVerified: Boolean(execution?.ok && checkLines.length === 1 && axiomAuditPresent && sourceTypeMatchesAudit),
    conditional: contract.conditional === true,
    conclusionAssumedAsPremise: contract.conclusionAssumedAsPremise === true,
    vacuous: contract.vacuous === true,
    verifiedObligations: sourceTypeMatchesAudit ? [...verifiedObligationIds] : [],
    axioms,
    axiomAuditPresent,
    hasSorry: /\bsorryAx\b|declaration uses 'sorry'/i.test(`${stdout}\n${stderr}`),
    hasAdmit: /\badmit\b/i.test(`${stdout}\n${stderr}`),
    auditReceiptHash: execution?.receiptHash || null,
    auditOutputUnambiguous: checkLines.length === 1 && axiomLines.length === 1,
  };
}

export function createLakeFormalVerifier({ projectRoot, dependencyScopeRoot = projectRoot, commandRunner, commandRunnerFactory = null, projectSnapshotRepository = createFormalProjectSnapshotRepository(), executable = 'lake', trustedAllowedAxioms = [], toolchainIdentityProvider = null, executionEnvironment: configuredExecutionEnvironment = process.env, requireImmutableExecutionClosure = false } = {}) {
  const replayAuthorityToken = Symbol('formal-certificate-replay-authority');
  const api = {
    version: 3,
    kind: 'LakeFormalVerifierAdapter',
    verifierId: 'lean-lake-explicit-source-audit-certificate-v3',
    async verify(options = {}, authorityToken = null) {
      if (Object.hasOwn(options, 'declarationReports') || Object.hasOwn(options, 'allowedAxioms')) {
        return { status: 'formal_verifier_blocked', blockers: ['formal_verifier_caller_authority_override_forbidden'] };
      }
      const { expectedInputs = [], timeoutMs = 120000, claimBindings = [], signal = null } = options;
      if (claimBindings.some((binding) => Object.hasOwn(binding || {}, 'auditFile'))) {
        return { status: 'formal_verifier_blocked', blockers: ['formal_verifier_caller_audit_override_forbidden'] };
      }
      const blockers = [];
      const required = ['lakefile.lean', 'lean-toolchain', 'lake-manifest.json'];
      let projectFiles = [];
      let projectClosure = null;
      try {
        projectClosure = await readFormalProjectClosure({ projectRoot, dependencyScopeRoot });
        projectFiles = executableProjectFiles([...(projectClosure.files || [])], {
          requireImmutableExecutionClosure,
        });
        blockers.push(...(projectClosure.blockers || []));
      } catch (error) { blockers.push(...String(error.message || error).split(',')); }
      const byPath = new Map(projectFiles.filter((file) => file.projectPath !== null).map((file) => [file.projectPath ?? file.path, file]));
      for (const relative of required) if (!byPath.has(relative)) blockers.push(`formal_project_file_missing:${relative}`);
      for (const expected of expectedInputs) {
        const actual = byPath.get(String(expected.path || ''));
        if (!actual) blockers.push(`formal_input_missing:${expected.path}`);
        else if (actual.hash !== expected.hash) blockers.push(`formal_input_hash_mismatch:${expected.path}`);
      }
      const toolchain = pinnedToolchain(projectRoot, projectFiles);
      if (!toolchain) blockers.push('formal_project_pinned_toolchain_invalid');
      let toolchainRuntimeIdentity = null;
      if (!toolchainIdentityProvider?.inspect) blockers.push('formal_toolchain_runtime_identity_provider_required');
      else {
        toolchainRuntimeIdentity = toolchainIdentityProvider.inspect({ forceContentRehash: authorityToken === replayAuthorityToken });
        if (toolchainRuntimeIdentity?.status !== 'lean_toolchain_identity_verified') {
          blockers.push('formal_toolchain_runtime_identity_invalid', ...(toolchainRuntimeIdentity?.blockers || []));
        }
        if (toolchainRuntimeIdentity?.toolchain !== toolchain) blockers.push('formal_toolchain_runtime_version_mismatch');
      }
      const systemAuditPlan = claimBindings.length ? canonicalAuditPlan(claimBindings) : null;
      if (claimBindings.length && !systemAuditPlan) blockers.push('formal_system_audit_contract_invalid');
      for (const claim of claimBindings) {
        const dynamicAuthority = claim?.formalClaimContract?.dynamicFormalClaimAuthority || null;
        if (!dynamicAuthority) continue;
        const sourceFile = safeSourceFile(claim.sourceFile);
        const sourceRead = sourceFile
          ? readScopedFileSync({ scopeRoot: projectRoot, candidate: path.join(projectRoot, sourceFile) })
          : null;
        const imports = sourceRead?.status === 'scoped_file_read_verified'
          ? leanSourceImports(sourceRead.content.toString('utf8'))
          : [];
        if (!sourceFile || sourceRead?.status !== 'scoped_file_read_verified') {
          blockers.push(`formal_dynamic_claim_source_invalid:${claim?.claimId || 'missing'}`);
        } else if (imports.some((moduleName) => !dynamicAuthority.allowedImports.includes(moduleName))) {
          blockers.push(`formal_dynamic_claim_import_not_allowed:${claim?.claimId || 'missing'}`);
        }
      }
      if (blockers.length) return { status: 'formal_verifier_blocked', blockers };
      const executionEnvironment = {
        ELAN_HOME: configuredExecutionEnvironment.ELAN_HOME
          || `${configuredExecutionEnvironment.HOME || ''}/.elan`,
        ELAN_TOOLCHAIN: toolchain,
      };
      let projectSnapshot = null;
      let execution = null;
      let audit = null;
      let formalProjectSnapshotSealReceipt = null;
      const auditTargets = systemAuditPlan?.entries.map((entry) => entry.sourceFile) || [];
      const executionInvocations = requireImmutableExecutionClosure
        ? auditTargets.map((target) => ['env', 'lean', target])
        : [auditTargets.length ? ['build', ...auditTargets] : ['build']];
      const formalAuditInvocationHash = hashRecord('FormalAuditInvocation', {
        executable: String(executable),
        ...(requireImmutableExecutionClosure
          ? { invocations: executionInvocations }
          : { arguments: executionInvocations[0] }),
        auditTargets,
        systemAuditHash: systemAuditPlan ? hashBytes(Buffer.from(systemAuditPlan.canonicalSource)) : null,
      });
      try {
        projectSnapshot = projectSnapshotRepository.materialize({ projectRoot, dependencyScopeRoot, projectFiles, systemAuditPlan });
        if (requireImmutableExecutionClosure) {
          formalProjectSnapshotSealReceipt = projectSnapshot.seal();
          if (formalProjectSnapshotSealReceipt.writableFileCount !== 0
            || formalProjectSnapshotSealReceipt.writableDirectoryCount !== 0) {
            throw new Error('formal_immutable_execution_snapshot_not_sealed');
          }
        }
        const executionRoot = projectSnapshot.root;
        if (requireImmutableExecutionClosure && !executionInvocations.length) {
          throw new Error('formal_immutable_execution_audit_target_required');
        }
        const beforeExecutionClosure = requireImmutableExecutionClosure
          ? await readFormalProjectClosure({
            projectRoot: executionRoot,
            dependencyScopeRoot: projectSnapshot.scopeRoot,
          }) : null;
        if (beforeExecutionClosure
          && beforeExecutionClosure.status !== 'formal_project_closure_verified') {
          throw new Error(`formal_immutable_execution_closure_invalid:${beforeExecutionClosure.blockers.join(',')}`);
        }
        const activeRunner = commandRunnerFactory
          ? commandRunnerFactory(executionRoot, projectSnapshot.scopeRoot) : commandRunner;
        const executions = [];
        for (const args of executionInvocations) {
          executions.push(await activeRunner.run({
            executable,
            args,
            cwd: executionRoot,
            sourceRoot: projectSnapshot.scopeRoot,
            timeoutMs,
            outputPaths: [],
            env: executionEnvironment,
            requireImmutableWorkRoot: requireImmutableExecutionClosure,
            signal,
          }));
        }
        execution = combineImmutableAuditExecutions(executions);
        if (requireImmutableExecutionClosure) {
          const afterExecutionClosure = await readFormalProjectClosure({
            projectRoot: executionRoot,
            dependencyScopeRoot: projectSnapshot.scopeRoot,
          });
          if (afterExecutionClosure.status !== 'formal_project_closure_verified'
            || beforeExecutionClosure.manifestHash !== afterExecutionClosure.manifestHash
            || JSON.stringify(immutableClosureFiles(beforeExecutionClosure))
              !== JSON.stringify(immutableClosureFiles(afterExecutionClosure))) {
            execution = {
              ...execution,
              ok: false,
              blockers: [...new Set([
                ...(execution?.blockers || []),
                'formal_immutable_execution_snapshot_drift',
              ])],
            };
          }
        }
        if (execution.ok && claimBindings.length) audit = execution;
      } catch (error) {
        execution = { ok: false, blockers: [error?.message || 'formal_fresh_project_execution_failed'], receiptHash: null };
      }
      if (execution?.ok) {
        const afterIdentity = toolchainIdentityProvider.inspect();
        if (afterIdentity?.status !== 'lean_toolchain_identity_verified'
          || afterIdentity.leanToolchainContentIdentityHash !== toolchainRuntimeIdentity.leanToolchainContentIdentityHash) {
          execution = { ...execution, ok: false, blockers: [...(execution.blockers || []), 'formal_toolchain_changed_during_execution'] };
        }
      }
      const effectiveDeclarations = [];
      if (execution.ok && claimBindings.length) {
        for (const claim of claimBindings) {
          const dynamicAuthority = claim?.formalClaimContract?.dynamicFormalClaimAuthority || null;
          const sourceFile = String(claim.sourceFile || '');
          const sourceBound = sourceFile && projectFiles.some((file) => (file.projectPath ?? file.path) === sourceFile);
          const obligationMapping = normalizeFormalProofObligationMappings({
            proofObligationContracts: claim.proofObligationContracts,
            proofObligations: claim.proofObligations || claim.obligationNames,
            proofObligationMappings: claim.proofObligationMappings,
            theoremName: claim.theoremName,
          });
          const declarationNames = [...new Set([
            claim.theoremName,
            ...obligationMapping.verificationTargets,
          ])];
          let sourceDeclarations = [];
          if (sourceBound) {
            const sourceRead = readScopedFileSync({ scopeRoot: projectRoot, candidate: path.join(projectRoot, sourceFile) });
            if (sourceRead.status === 'scoped_file_read_verified') {
              sourceDeclarations = leanSourceDeclarationRecords(sourceRead.content.toString('utf8'));
            }
          }
          for (const declarationName of declarationNames) {
            const matches = sourceDeclarations.filter((item) => item.name === declarationName);
            const sourceDeclaration = matches.length === 1 ? matches[0] : null;
            const verifiedObligationIds = obligationMapping.mappings
              .filter((mapping) => mapping.leanDeclarations.includes(declarationName))
              .map((mapping) => mapping.obligationId);
            const expectedLeanTypeContracts = obligationMapping.mappings
              .filter((mapping) => mapping.leanDeclarations.includes(declarationName))
              .map((mapping) => autonomousFormalLeanTypeContractForObligation(mapping.displayText))
              .filter(Boolean);
            const dynamicExpectedLeanTypeContract = dynamicAuthority
              && declarationName === claim.theoremName
              ? Object.freeze({ expectedType: dynamicAuthority.leanTypeSource })
              : null;
            const expectedLeanTypeContract = dynamicExpectedLeanTypeContract
              || expectedLeanTypeContracts[0] || null;
            if ((sourceFile && !sourceBound) || (sourceFile && !sourceDeclaration)) {
              effectiveDeclarations.push({ name: declarationName, typeHash: sourceDeclaration?.typeHash || null, sourceStatementHash: sourceDeclaration?.statementHash || null, buildVerified: false, conditional: sourceDeclaration?.conditional === true, conclusionAssumedAsPremise: sourceDeclaration?.conclusionAssumedAsPremise === true, verifiedObligations: [], axioms: [], auditReceiptHash: null });
              continue;
            }
            effectiveDeclarations.push(declarationFromAudit(
              declarationName,
              audit,
              sourceDeclaration,
              verifiedObligationIds,
              expectedLeanTypeContract,
            ));
          }
        }
      }
      projectSnapshot?.cleanup();
      const claimBindingReport = execution.ok && claimBindings.length
        ? evaluateFormalClaimBindings({ claims: claimBindings, declarations: effectiveDeclarations, allowedAxioms: trustedAllowedAxioms })
        : null;
      const leanReadableProofPrintAudits = execution.ok && claimBindings.length
        ? extractLeanReadableProofAudits({
          stdout: execution.stdout,
          claimBindings,
          declarations: effectiveDeclarations,
          projectFiles,
          executionReceiptHash: execution.receiptHash || null,
        }) : Object.freeze([]);
      const status = !execution.ok
        ? 'formal_certificate_blocked'
        : !claimBindingReport
          ? 'formal_build_verified'
          : claimBindingReport.status === 'formal_claim_binding_verified'
            ? 'formal_claim_verified'
            : 'formal_claim_binding_blocked';
      const bundle = {
        version: 1,
        kind: 'FormalCertificateBundle',
        verifierId: 'lean-lake-explicit-source-audit-certificate-v3',
        status,
        projectFiles: projectFiles.sort((a, b) => a.path.localeCompare(b.path)),
        projectManifestHash: projectManifestHash(projectFiles),
        formalProjectClosureHash: projectClosure?.formalProjectClosureHash || null,
        dependencyClosure: projectClosure ? Object.freeze({
          projectScopePath: projectClosure.projectScopePath,
          fileCount: projectClosure.fileCount,
          totalBytes: projectClosure.totalBytes,
          externalDependencyFileCount: projectClosure.externalDependencyFileCount,
          lakePackageFileCount: projectClosure.lakePackageFileCount,
          manifestHash: projectClosure.manifestHash,
        }) : null,
        formalProjectSnapshotSealReceipt,
        formalProjectSnapshotSealReceiptHash:
          formalProjectSnapshotSealReceipt
            ?.formalProjectSnapshotSealReceiptHash || null,
        systemAuditHash: systemAuditPlan ? hashBytes(Buffer.from(systemAuditPlan.canonicalSource)) : null,
        auditTargets,
        formalAuditInvocationHash,
        toolchainHash: projectFile(projectFiles, 'lean-toolchain')?.hash || null,
        toolchain,
        manifestHash: projectFile(projectFiles, 'lake-manifest.json')?.hash || null,
        toolchainRuntimeIdentity,
        claimBindings: claimBindings.map((binding) => ({ ...binding })),
        executionReceiptHash: execution.receiptHash || null,
        executionIdentity: executionIdentity(execution),
        isolation: execution.isolation || null,
        claimBindingReport,
        leanReadableProofPrintAudits,
        leanReadableProofPrintAuditSetHash:
          leanReadableProofAuditSetHash(leanReadableProofPrintAudits),
        productionReadableProofReady: Boolean(claimBindings.length)
          && leanReadableProofPrintAudits.length === claimBindings.length
          && leanReadableProofPrintAudits.every((item) => (
            item.status === 'lean_readable_proof_print_verified'
          )),
        blockers: execution.ok ? (claimBindingReport?.blockers || []) : ['lake_build_failed', ...(execution.blockers || [])],
        externalActionPerformed: false,
      };
      return { ...bundle, certificateBundleHash: hashRecord('FormalCertificateBundle', bundle) };
    },
    async replay({ certificateBundle, timeoutMs = 120000, signal = null } = {}) {
      if (!['formal_build_verified', 'formal_claim_verified'].includes(certificateBundle?.status)) return { status: 'formal_certificate_replay_blocked', blockers: ['certificate_bundle_not_verified'] };
      const { certificateBundleHash, ...certificatePayload } = certificateBundle || {};
      if (!certificateBundleHash || hashRecord('FormalCertificateBundle', certificatePayload) !== certificateBundleHash) {
        return { status: 'formal_certificate_replay_blocked', blockers: ['formal_certificate_bundle_hash_invalid'] };
      }
      let current;
      let currentClosure;
      try {
        currentClosure = await readFormalProjectClosure({ projectRoot, dependencyScopeRoot });
        if (currentClosure.status !== 'formal_project_closure_verified') {
          return { status: 'formal_certificate_replay_blocked', blockers: currentClosure.blockers };
        }
        current = [...currentClosure.files];
      }
      catch (error) { return { status: 'formal_certificate_replay_blocked', blockers: String(error.message || error).split(',') }; }
      const expected = certificateBundle.projectFiles || [];
      if (projectManifestHash(expected) !== certificateBundle.projectManifestHash) {
        return { status: 'formal_certificate_replay_blocked', blockers: ['formal_certificate_project_manifest_invalid'] };
      }
      const expectedByPath = new Map(expected.map((file) => [file.path, file]));
      const currentByPath = new Map(current.map((file) => [file.path, file]));
      const blockers = [];
      for (const file of expected) {
        const actual = currentByPath.get(file.path);
        if (!actual) blockers.push(`formal_input_missing:${file.path}`);
        else if (actual.hash !== file.hash || actual.bytes !== file.bytes
          || (actual.sourcePath || actual.path) !== (file.sourcePath || file.path)
          || (actual.projectPath ?? actual.path) !== (file.projectPath ?? file.path)
          || (actual.role || 'project') !== (file.role || 'project')) blockers.push(`formal_input_hash_mismatch:${file.path}`);
        else if (actual.posixMode !== file.posixMode) blockers.push(`formal_input_mode_mismatch:${file.path}`);
      }
      for (const file of current) if (!expectedByPath.has(file.path)) blockers.push(`formal_project_unlisted_input:${file.path}`);
      if (blockers.length) return { status: 'formal_certificate_replay_blocked', blockers: [...new Set(blockers)] };
      const rerun = await api.verify({
        expectedInputs: expected.filter((file) => file.projectPath !== null).map((file) => ({
          path: file.projectPath ?? file.path,
          hash: file.hash,
        })),
        timeoutMs,
        claimBindings: certificateBundle.claimBindings || [],
        signal,
      }, replayAuthorityToken);
      const expectedStatus = certificateBundle.status;
      if (rerun.status !== expectedStatus) {
        return { status: 'formal_certificate_replay_blocked', blockers: ['formal_project_reexecution_mismatch', ...(rerun.blockers || [])], rerun };
      }
      if (JSON.stringify(rerun.executionIdentity) !== JSON.stringify(certificateBundle.executionIdentity)
        || rerun.toolchain !== certificateBundle.toolchain
        || rerun.toolchainHash !== certificateBundle.toolchainHash
        || rerun.toolchainRuntimeIdentity?.leanToolchainContentIdentityHash !== certificateBundle.toolchainRuntimeIdentity?.leanToolchainContentIdentityHash
        || rerun.systemAuditHash !== certificateBundle.systemAuditHash
        || JSON.stringify(rerun.auditTargets) !== JSON.stringify(certificateBundle.auditTargets)
        || rerun.formalAuditInvocationHash !== certificateBundle.formalAuditInvocationHash
        || rerun.projectManifestHash !== certificateBundle.projectManifestHash
        || rerun.formalProjectClosureHash !== certificateBundle.formalProjectClosureHash
        || rerun.leanReadableProofPrintAuditSetHash
          !== certificateBundle.leanReadableProofPrintAuditSetHash
        || rerun.productionReadableProofReady !== certificateBundle.productionReadableProofReady
        || rerun.claimBindingReport?.formalClaimBindingHash !== certificateBundle.claimBindingReport?.formalClaimBindingHash) {
        return { status: 'formal_certificate_replay_blocked', blockers: ['formal_replay_authority_identity_mismatch'], rerun };
      }
      const replay = {
        version: 1,
        kind: 'FormalCertificateReplayReceipt',
        status: expectedStatus === 'formal_claim_verified' ? 'formal_claim_replay_verified' : 'formal_build_replay_verified',
        blockers: [],
        originalCertificateBundleHash: certificateBundleHash,
        rerunCertificateBundleHash: rerun.certificateBundleHash,
        projectManifestHash: rerun.projectManifestHash,
        systemAuditHash: rerun.systemAuditHash,
        toolchainHash: rerun.toolchainHash,
        toolchain: rerun.toolchain,
        toolchainRuntimeIdentity: rerun.toolchainRuntimeIdentity,
        formalProjectClosureHash: rerun.formalProjectClosureHash,
        leanReadableProofPrintAuditSetHash: rerun.leanReadableProofPrintAuditSetHash,
        productionReadableProofReady: rerun.productionReadableProofReady,
        executionIdentity: rerun.executionIdentity,
        externalActionPerformed: false,
      };
      return Object.freeze({ ...replay, formalCertificateReplayReceiptHash: hashRecord('FormalCertificateReplayReceipt', replay) });
    },
  };
  return assertFormalVerifierPort(api);
}
