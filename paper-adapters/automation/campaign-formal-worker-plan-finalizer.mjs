import fs from 'node:fs';
import path from 'node:path';
import { manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
import { PRODUCTION_LEAN_TOOLCHAIN } from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { leanSourceDeclarationRecords } from '../research-verify/lean-source-contracts.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { writeDurableTextSync } from '../runtime/durable-text-repository.mjs';

function leanFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
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
  if (!dynamicClaims.length && declarations.length !== claims.length) {
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
  if (!fs.existsSync(path.join(workspace, 'lake-manifest.json'))) {
    writeDurableJsonSync(path.join(workspace, 'lake-manifest.json'), {
      version: '1.1.0',
      packagesDir: '.lake/packages',
      packages: [],
    });
  }
  writeDurableJsonSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json'), plan);
  return Object.freeze({ status: 'formal_worker_plan_system_finalized', plan });
}
