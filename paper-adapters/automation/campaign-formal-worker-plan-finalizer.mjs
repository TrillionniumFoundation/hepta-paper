import fs from 'node:fs';
import path from 'node:path';
import { manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
import { PRODUCTION_LEAN_TOOLCHAIN } from '../../paper-domain/research/formal-verifier-policy.mjs';
import { leanTypeIdentity } from '../../paper-domain/research/lean-type-identity.mjs';
import {
  exactAutonomousFormalSupportTemplateForTheoremClaim,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { leanSourceDeclarationRecords } from '../research-verify/lean-source-contracts.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { writeDurableTextSync } from '../runtime/durable-text-repository.mjs';

const SYSTEM_FORMAL_LAKE_PACKAGE = 'heptaCampaignFormal';
const LEAN_MODULE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SYSTEM_FORMAL_LAKE_MANIFEST = Object.freeze({
  version: '1.1.0',
  packagesDir: '.lake/packages',
  packages: Object.freeze([]),
  name: SYSTEM_FORMAL_LAKE_PACKAGE,
  lakeDir: '.lake',
});

function formalTypeAuthority({ claim, declaration, registryTemplate }) {
  const dynamicAuthority = claim?.proposalClaimSource?.dynamicFormalClaimSeedHash
    ? claim.proposalClaimSource : null;
  const payload = dynamicAuthority ? {
    version: 1,
    kind: 'FormalTypeAuthorityBinding',
    status: 'formal_exact_type_authority_verified',
    authorityKind: 'dynamic_typed_seed',
    authorityRecordHash: dynamicAuthority.dynamicFormalClaimSeedHash,
    authoritativeTheoremName: dynamicAuthority.leanDeclarationName,
    authoritativeTypeHash: dynamicAuthority.leanNormalizedTypeHash,
    observedAuthorDeclarationTypeHash: declaration.typeHash,
    independentOfAuthorDeclaration: true,
    machineClosedLoopPromotionAllowed: true,
  } : registryTemplate ? {
    version: 1,
    kind: 'FormalTypeAuthorityBinding',
    status: 'formal_exact_type_authority_verified',
    authorityKind: 'system_registry_verified_ir',
    authorityRecordHash:
      registryTemplate.leanTypeContract.autonomousFormalLeanTypeContractHash,
    authoritativeTheoremName:
      registryTemplate.leanTypeContract.canonicalTheoremName,
    authoritativeTypeHash: leanTypeIdentity(
      registryTemplate.leanTypeContract.expectedType,
    ).normalizedTypeHash,
    observedAuthorDeclarationTypeHash: declaration.typeHash,
    independentOfAuthorDeclaration: true,
    machineClosedLoopPromotionAllowed: true,
  } : {
    version: 1,
    kind: 'FormalTypeAuthorityBinding',
    status: 'formal_exact_type_authority_unavailable',
    authorityKind: 'semantic_review_only_author_declaration',
    authorityRecordHash: null,
    authoritativeTheoremName: null,
    authoritativeTypeHash: null,
    observedAuthorDeclarationTypeHash: declaration.typeHash,
    independentOfAuthorDeclaration: false,
    machineClosedLoopPromotionAllowed: false,
  };
  return Object.freeze({
    ...payload,
    formalTypeAuthorityBindingHash: hashRecord('FormalTypeAuthorityBinding', payload),
  });
}

function leanModuleName(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized.endsWith('.lean')) return null;
  const segments = normalized.slice(0, -'.lean'.length).split('/');
  return segments.length && segments.every((segment) => LEAN_MODULE_SEGMENT.test(segment))
    ? segments.join('.') : null;
}

function systemFormalLakefile(selectedSources) {
  const roots = selectedSources.map((source) => leanModuleName(source.relative));
  if (!roots.length || roots.some((root) => !root)
    || new Set(roots).size !== roots.length) {
    throw new Error('formal_worker_plan_lean_module_path_invalid');
  }
  return [
    'import Lake',
    'open Lake DSL',
    `package ${SYSTEM_FORMAL_LAKE_PACKAGE} where`,
    '',
    '@[default_target]',
    'lean_lib HeptaCampaignFormal where',
    `  roots := #[${roots.map((root) => `\`${root}`).join(', ')}]`,
    '',
  ].join('\n');
}

function leanFiles(root, current = root, files = []) {
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (['.git', '.lake', 'build'].includes(entry.name)) continue;
    const candidate = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error('formal_worker_plan_lean_source_symlink_forbidden');
    if (entry.isDirectory()) leanFiles(root, candidate, files);
    else if (entry.isFile() && entry.name.endsWith('.lean') && entry.name !== 'lakefile.lean') {
      files.push(path.relative(root, candidate).replace(/\\/g, '/'));
    }
  }
  return files;
}

export function finalizeCampaignFormalWorkerPlan({
  workspace,
  paperId,
  taskKey,
  theoremSpecification,
} = {}) {
  if (!workspace || !paperId || !taskKey || !theoremSpecification?.theoremSpecificationHash) {
    throw new Error('formal_worker_plan_finalizer_input_invalid');
  }
  const claims = Array.isArray(theoremSpecification.claims)
    ? theoremSpecification.claims : [];
  const dynamicClaims = claims.filter((claim) => (
    claim?.proposalClaimSource?.dynamicFormalClaimSeedHash
  ));
  if (dynamicClaims.length && dynamicClaims.length !== claims.length) {
    throw new Error('formal_worker_plan_mixed_authority_unsupported');
  }
  const sources = leanFiles(workspace).map((relative) => {
    const bytes = fs.readFileSync(path.join(workspace, relative));
    return Object.freeze({
      relative,
      hash: hashBytes(bytes),
      declarations: leanSourceDeclarationRecords(bytes.toString('utf8')),
    });
  });
  const declarations = sources.flatMap((source) => source.declarations
    .map((declaration) => ({ source, declaration })));
  if (declarations.length !== claims.length) {
    throw new Error('formal_worker_plan_declaration_count_mismatch');
  }
  const bindings = claims.map((claim, index) => {
    const authority = claim.proposalClaimSource;
    const matches = dynamicClaims.length
      ? declarations.filter(({ declaration }) => (
        declaration.name === authority.leanDeclarationName
      )) : [declarations[index]];
    if (matches.length !== 1) {
      throw new Error(`formal_worker_plan_declaration_identity_invalid:${claim.claimId}`);
    }
    const { source, declaration } = matches[0];
    if (dynamicClaims.length && declaration.typeHash !== authority.leanNormalizedTypeHash) {
      throw new Error(`formal_worker_plan_declaration_type_mismatch:${claim.claimId}`);
    }
    const registryTemplate = dynamicClaims.length ? null
      : exactAutonomousFormalSupportTemplateForTheoremClaim({
        theoremSpecification,
        claim,
      });
    if (registryTemplate
      && declaration.name !== registryTemplate.leanTypeContract.canonicalTheoremName) {
      throw new Error(`formal_worker_plan_registry_declaration_name_mismatch:${claim.claimId}`);
    }
    if (registryTemplate && declaration.typeHash !== leanTypeIdentity(
      registryTemplate.leanTypeContract.expectedType,
    ).normalizedTypeHash) {
      throw new Error(`formal_worker_plan_registry_declaration_type_mismatch:${claim.claimId}`);
    }
    const typeAuthority = formalTypeAuthority({ claim, declaration, registryTemplate });
    const sourceLocator = `${claim.manuscriptSource.path}#bytes=${claim.manuscriptSource.byteStart}-${claim.manuscriptSource.byteEnd}`;
    return Object.freeze({
      claimId: claim.claimId,
      manuscriptClaimHash: manuscriptClaimHash({
        claimId: claim.claimId,
        text: claim.statement,
        sourceLocator,
      }),
      theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
      theoremSpecificationClaimHash: claim.theoremSpecificationClaimHash,
      theoremName: declaration.name,
      sourceFile: source.relative,
      expectedTypeHash: declaration.typeHash,
      formalizationMode: typeAuthority.machineClosedLoopPromotionAllowed
        ? 'independent_exact_type_authority'
        : 'semantic_review_only_no_independent_exact_type_authority',
      formalTypeAuthority: typeAuthority,
      machineClosedLoopPromotionAllowed:
        typeAuthority.machineClosedLoopPromotionAllowed,
      sourceStatementHash: declaration.statementHash,
      proofObligations: claim.proofObligations,
      proofObligationContracts: claim.proofObligationContracts,
      proofObligationMappings: claim.proofObligationContracts.map((obligation) => ({
        ...obligation,
        leanDeclarations: [declaration.name],
      })),
      manuscriptSource: {
        path: claim.manuscriptSource.path,
        byteStart: claim.manuscriptSource.byteStart,
        byteEnd: claim.manuscriptSource.byteEnd,
        contentHash: claim.manuscriptSource.contentHash,
      },
    });
  });
  const selectedSources = [...new Set(bindings.map((binding) => binding.sourceFile))]
    .map((relative) => sources.find((source) => source.relative === relative));
  const canonicalLakefile = systemFormalLakefile(selectedSources);
  const plan = {
    version: 1,
    kind: 'NativeResearchWorkerPlan',
    paperId,
    taskKey,
    workers: [{
      id: 'system-finalized-lean-proof',
      type: 'formal_verifier_lake',
      evidenceClass: 'research_evidence',
      syntheticInput: false,
      outcomesPreprogrammed: false,
      claimIds: bindings.map((binding) => binding.claimId),
      inputs: selectedSources.map((source) => ({
        role: 'formal_source', path: source.relative, sha256: source.hash,
      })),
      parameters: {
        projectRoot: '.', executable: 'lake', claimBindings: bindings,
      },
    }],
  };
  writeDurableTextSync(
    path.join(workspace, 'lean-toolchain'),
    `${PRODUCTION_LEAN_TOOLCHAIN}\n`,
  );
  writeDurableTextSync(path.join(workspace, 'lakefile.lean'), canonicalLakefile);
  writeDurableJsonSync(
    path.join(workspace, 'lake-manifest.json'),
    SYSTEM_FORMAL_LAKE_MANIFEST,
  );
  writeDurableJsonSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json'), plan);
  return Object.freeze({ status: 'formal_worker_plan_system_finalized', plan });
}
