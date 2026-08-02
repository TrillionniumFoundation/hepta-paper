import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { readFormalClaimUniverse } from './formal-claim-universe-reader.mjs';

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function manuscriptRelativePath(sourceRoot, paperTask) {
  const mainTex = String(paperTask?.mainTex || '').replace(/\\/g, '/');
  const sourceWorkspace = String(paperTask?.sourceWorkspace || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const relativeMainTex = sourceWorkspace && mainTex.startsWith(`${sourceWorkspace}/`)
    ? mainTex.slice(sourceWorkspace.length + 1)
    : mainTex;
  const absolute = path.isAbsolute(mainTex)
    ? path.resolve(mainTex)
    : path.resolve(sourceRoot, relativeMainTex);
  const relative = path.relative(sourceRoot, absolute).replace(/\\/g, '/');
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)
    ? relative
    : null;
}

export function canonicalClaimsFromWorkerPlan({ sourceRoot, paperTask, plan } = {}) {
  const blockers = [];
  const claims = [];
  const byClaimId = new Map();
  const manuscriptPath = manuscriptRelativePath(sourceRoot, paperTask);
  const read = manuscriptPath
    ? readScopedFileSync({ scopeRoot: sourceRoot, candidate: path.join(sourceRoot, manuscriptPath) })
    : null;
  if (!manuscriptPath || read?.status !== 'scoped_file_read_verified') {
    blockers.push('canonical_claim_registry_manuscript_unreadable');
    return { status: 'canonical_claim_registry_blocked', manuscriptPath, manuscriptHash: null, claims, byClaimId, blockers };
  }
  const formalClaimUniverse = readFormalClaimUniverse({ sourceRoot, manuscriptPath });
  const formalWorkers = (Array.isArray(plan?.workers) ? plan.workers : [])
    .filter((worker) => worker?.type === 'formal_verifier_lake');
  const bindings = formalWorkers.flatMap((worker) => Array.isArray(worker?.parameters?.claimBindings)
    ? worker.parameters.claimBindings
    : []);
  if (formalWorkers.length) {
    if (!bindings.length) blockers.push('canonical_claim_registry_bindings_missing');
    if (!formalClaimUniverse.theorems.length) blockers.push('formal_claim_universe_theorems_missing');
    blockers.push(...formalClaimUniverse.blockers);
  }
  const theoremBySource = new Map(formalClaimUniverse.theorems.map((theorem) => [
    `${theorem.manuscriptPath}:${theorem.manuscriptByteStart}:${theorem.manuscriptByteEnd}`,
    theorem,
  ]));
  const manuscriptFilePaths = new Set(formalClaimUniverse.files.map((file) => file.path));
  const boundTheoremIds = new Set();
  for (const binding of bindings) {
    const claimId = String(binding?.claimId || '').trim();
    const locator = binding?.manuscriptSource;
    const relative = String(locator?.path || '').replace(/\\/g, '/');
    const byteStart = integer(locator?.byteStart);
    const byteEnd = integer(locator?.byteEnd);
    const claimBlockers = [];
    if (!claimId) claimBlockers.push('canonical_claim_id_missing');
    if (!relative || !manuscriptFilePaths.has(relative)) claimBlockers.push('canonical_claim_manuscript_path_mismatch');
    const bindingRead = relative && manuscriptFilePaths.has(relative)
      ? readScopedFileSync({ scopeRoot: sourceRoot, candidate: path.join(sourceRoot, relative) })
      : null;
    if (bindingRead?.status !== 'scoped_file_read_verified') claimBlockers.push('canonical_claim_manuscript_file_unreadable');
    if (byteStart === null || byteEnd === null || byteEnd <= byteStart || byteEnd > Number(bindingRead?.content?.length || 0)) {
      claimBlockers.push('canonical_claim_byte_range_invalid');
    }
    const bytes = claimBlockers.includes('canonical_claim_byte_range_invalid')
      ? Buffer.alloc(0)
      : bindingRead.content.subarray(byteStart, byteEnd);
    const contentHash = bytes.length ? hashBytes(bytes) : null;
    if (!locator?.contentHash || locator.contentHash !== contentHash) claimBlockers.push('canonical_claim_content_hash_mismatch');
    const theorem = byteStart === null || byteEnd === null
      ? null
      : theoremBySource.get(`${relative}:${byteStart}:${byteEnd}`) || null;
    if (!theorem || theorem.manuscriptContentHash !== contentHash) {
      claimBlockers.push('canonical_claim_not_exact_formal_theorem_body');
    } else if (boundTheoremIds.has(theorem.theoremId)) {
      claimBlockers.push('canonical_claim_formal_theorem_duplicate_binding');
    }
    const text = bytes.toString('utf8');
    if (!text.trim() || !Buffer.from(text, 'utf8').equals(bytes)) claimBlockers.push('canonical_claim_utf8_text_invalid');
    if (byClaimId.has(claimId)) claimBlockers.push('canonical_claim_id_duplicate');
    blockers.push(...claimBlockers.map((item) => `${claimId || 'missing'}:${item}`));
    if (claimBlockers.length) continue;
    boundTheoremIds.add(theorem.theoremId);
    const sourceLocator = `${relative}#bytes=${byteStart}-${byteEnd}`;
    const claim = Object.freeze({
      id: claimId,
      claimId,
      text,
      sourceLocator,
      manuscriptPath: relative,
      manuscriptByteStart: byteStart,
      manuscriptByteEnd: byteEnd,
      manuscriptContentHash: contentHash,
      manuscriptFileHash: bindingRead.hash,
      manuscriptClaimHash: manuscriptClaimHash({ claimId, text, sourceLocator }),
      formalClaimUniverseEntryHash: theorem.formalClaimUniverseEntryHash,
      formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
      formalTheoremId: theorem.theoremId,
      formalTheoremEnvironment: theorem.environment,
      formalProof: theorem.proof,
      status: 'candidate',
      kind: 'formal_claim',
      verificationPlan: Object.freeze({
        kind: 'formal_lake_machine_checked',
        requiresWorker: true,
        requiresEvidence: false,
        verifier: 'lean-lake-explicit-source-audit-certificate-v3',
      }),
      proofObligations: Array.isArray(binding?.proofObligations || binding?.obligationNames)
        ? [...(binding.proofObligations || binding.obligationNames)].map(String).sort()
        : [],
    });
    claims.push(claim);
    byClaimId.set(claimId, claim);
  }
  if (formalWorkers.length) {
    for (const theorem of formalClaimUniverse.theorems) {
      if (!boundTheoremIds.has(theorem.theoremId)) blockers.push(`formal_claim_universe_theorem_unbound:${theorem.theoremId}`);
    }
    if (bindings.length !== formalClaimUniverse.theorems.length) blockers.push('formal_claim_universe_binding_count_mismatch');
  }
  const registryPayload = {
    version: 2,
    kind: 'CanonicalFormalClaimRegistry',
    manuscriptPath,
    manuscriptHash: formalClaimUniverse.manuscriptHash,
    formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
    claimIdentities: claims.map((claim) => ({
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      formalClaimUniverseEntryHash: claim.formalClaimUniverseEntryHash,
    })),
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({
    status: blockers.length ? 'canonical_claim_registry_blocked' : 'canonical_claim_registry_verified',
    manuscriptPath,
    manuscriptHash: formalClaimUniverse.manuscriptHash,
    formalClaimUniverse,
    formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
    canonicalClaimRegistryHash: hashRecord('CanonicalFormalClaimRegistry', registryPayload),
    claims: Object.freeze(claims),
    byClaimId,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function canonicalClaimsFromTheoremSpecification({ sourceRoot, theoremSpecification } = {}) {
  const blockers = [];
  const claims = [];
  const byClaimId = new Map();
  const manuscriptPath = String(theoremSpecification?.sourceManuscriptPath || '')
    .replace(/\\/g, '/').replace(/^\.\//, '');
  const read = manuscriptPath
    ? readScopedFileSync({ scopeRoot: sourceRoot, candidate: path.join(sourceRoot, manuscriptPath) })
    : null;
  if (!manuscriptPath || read?.status !== 'scoped_file_read_verified') {
    blockers.push('canonical_claim_registry_manuscript_unreadable');
    return Object.freeze({
      status: 'canonical_claim_registry_blocked', manuscriptPath,
      manuscriptHash: null, claims: Object.freeze(claims), byClaimId,
      blockers: Object.freeze(blockers),
    });
  }
  const formalClaimUniverse = readFormalClaimUniverse({ sourceRoot, manuscriptPath });
  if (theoremSpecification?.sourceManuscriptHash !== formalClaimUniverse.manuscriptHash) {
    blockers.push('canonical_claim_registry_manuscript_hash_mismatch');
  }
  if (theoremSpecification?.formalClaimUniverseHash !== formalClaimUniverse.formalClaimUniverseHash) {
    blockers.push('canonical_claim_registry_formal_claim_universe_hash_mismatch');
  }
  blockers.push(...formalClaimUniverse.blockers);
  const theoremBySource = new Map(formalClaimUniverse.theorems.map((theorem) => [
    `${theorem.manuscriptPath}:${theorem.manuscriptByteStart}:${theorem.manuscriptByteEnd}`,
    theorem,
  ]));
  const boundTheoremIds = new Set();
  for (const specificationClaim of theoremSpecification?.claims || []) {
    const claimId = String(specificationClaim?.claimId || '').trim();
    const locator = specificationClaim?.manuscriptSource;
    const relative = String(locator?.path || '').replace(/\\/g, '/');
    const byteStart = integer(locator?.byteStart);
    const byteEnd = integer(locator?.byteEnd);
    const claimBlockers = [];
    const theorem = byteStart === null || byteEnd === null
      ? null : theoremBySource.get(`${relative}:${byteStart}:${byteEnd}`) || null;
    if (!claimId) claimBlockers.push('canonical_claim_id_missing');
    if (!theorem) claimBlockers.push('canonical_claim_not_exact_formal_theorem_body');
    if (theorem && boundTheoremIds.has(theorem.theoremId)) {
      claimBlockers.push('canonical_claim_formal_theorem_duplicate_binding');
    }
    if (theorem && (locator?.contentHash !== theorem.manuscriptContentHash
      || locator?.formalClaimUniverseEntryHash !== theorem.formalClaimUniverseEntryHash
      || normalizedText(specificationClaim?.statement) !== normalizedText(theorem.text))) {
      claimBlockers.push('canonical_claim_theorem_specification_binding_mismatch');
    }
    if (byClaimId.has(claimId)) claimBlockers.push('canonical_claim_id_duplicate');
    blockers.push(...claimBlockers.map((item) => `${claimId || 'missing'}:${item}`));
    if (claimBlockers.length) continue;
    boundTheoremIds.add(theorem.theoremId);
    const sourceLocator = `${relative}#bytes=${byteStart}-${byteEnd}`;
    const claim = Object.freeze({
      id: claimId,
      claimId,
      text: theorem.text,
      sourceLocator,
      manuscriptPath: relative,
      manuscriptByteStart: byteStart,
      manuscriptByteEnd: byteEnd,
      manuscriptContentHash: theorem.manuscriptContentHash,
      manuscriptFileHash: read.hash,
      manuscriptClaimHash: manuscriptClaimHash({ claimId, text: theorem.text, sourceLocator }),
      formalClaimUniverseEntryHash: theorem.formalClaimUniverseEntryHash,
      formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
      formalTheoremId: theorem.theoremId,
      formalTheoremEnvironment: theorem.environment,
      formalProof: theorem.proof,
      status: 'candidate',
      kind: 'formal_claim',
      verificationPlan: Object.freeze({
        kind: 'formal_lake_machine_checked',
        requiresWorker: true,
        requiresEvidence: false,
        verifier: 'lean-lake-explicit-source-audit-certificate-v3',
      }),
      proofObligations: Object.freeze([...(specificationClaim?.proofObligations || [])]
        .map(String).sort()),
    });
    claims.push(claim);
    byClaimId.set(claimId, claim);
  }
  for (const theorem of formalClaimUniverse.theorems) {
    if (!boundTheoremIds.has(theorem.theoremId)) {
      blockers.push(`formal_claim_universe_theorem_unbound:${theorem.theoremId}`);
    }
  }
  if (claims.length !== formalClaimUniverse.theorems.length) {
    blockers.push('formal_claim_universe_binding_count_mismatch');
  }
  const uniqueBlockers = [...new Set(blockers)];
  const registryPayload = {
    version: 2,
    kind: 'CanonicalFormalClaimRegistry',
    manuscriptPath,
    manuscriptHash: formalClaimUniverse.manuscriptHash,
    formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
    claimIdentities: claims.map((claim) => ({
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      formalClaimUniverseEntryHash: claim.formalClaimUniverseEntryHash,
    })),
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    status: uniqueBlockers.length
      ? 'canonical_claim_registry_blocked' : 'canonical_claim_registry_verified',
    manuscriptPath,
    manuscriptHash: formalClaimUniverse.manuscriptHash,
    formalClaimUniverse,
    formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
    canonicalClaimRegistryHash: hashRecord('CanonicalFormalClaimRegistry', registryPayload),
    claims: Object.freeze(claims),
    byClaimId,
    blockers: Object.freeze(uniqueBlockers),
  });
}
