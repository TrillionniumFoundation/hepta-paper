import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const EXTERNAL_INTAKE_OUTPUT_SPECS = Object.freeze([
  Object.freeze({ name: 'OWNER_ACCEPTANCE_REQUEST.json', role: 'owner_acceptance_request' }),
  Object.freeze({ name: 'AUTHORITY_ONBOARDING_PACKET.json', role: 'authority_onboarding_packet' }),
  Object.freeze({ name: 'AUTHORITY_TRUST_STORE_TEMPLATE.json', role: 'authority_trust_store_template' }),
  Object.freeze({ name: 'OWNER_TRUST_STORE_TEMPLATE.json', role: 'owner_trust_store_template' }),
  Object.freeze({ name: 'CAPABILITY_OWNER_ACCEPTANCE_TEMPLATE.json', role: 'owner_acceptance_template' }),
  Object.freeze({ name: 'OPERATIONAL_PROOF_PLAN.json', role: 'operational_proof_plan' }),
  Object.freeze({ name: 'OPERATIONAL_RECEIPT_TEMPLATES.json', role: 'operational_receipt_templates' }),
  Object.freeze({ name: 'REAL_PAPER_PRODUCTION_CHAIN_REQUEST.json', role: 'real_paper_production_chain_request' }),
  Object.freeze({ name: 'OFFHOST_WORM_ONBOARDING_PACKET.json', role: 'offhost_worm_onboarding_packet' }),
]);

function requiredString(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
}

export function assertCleanExternalIntakeCodeProvenance(provenance) {
  if (provenance?.version !== 2 || provenance?.kind !== 'CodeProvenance') {
    throw new Error('external_intake_code_provenance_identity_invalid');
  }
  requiredString(provenance.packageVersion, 'external_intake_code_provenance_package_version_invalid');
  if (!OBJECT_ID_PATTERN.test(provenance.commit || '')) {
    throw new Error('external_intake_code_provenance_commit_invalid');
  }
  if (!OBJECT_ID_PATTERN.test(provenance.commitTree || '')) {
    throw new Error('external_intake_code_provenance_commit_tree_invalid');
  }
  if (!Array.isArray(provenance.tags)
    || provenance.tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('external_intake_code_provenance_tags_invalid');
  }
  if (provenance.treeDirty !== false) {
    throw new Error('external_intake_clean_worktree_required');
  }
  for (const [field, code] of [
    ['indexStateHash', 'external_intake_code_provenance_index_hash_invalid'],
    ['repositoryContentHash', 'external_intake_code_provenance_repository_hash_invalid'],
    ['worktreeStateHash', 'external_intake_code_provenance_worktree_hash_invalid'],
  ]) {
    if (!SHA256_PATTERN.test(provenance[field] || '')) throw new Error(code);
  }
  if (!Number.isInteger(provenance.repositoryEntryCount)
    || provenance.repositoryEntryCount < 1) {
    throw new Error('external_intake_code_provenance_entry_count_invalid');
  }
  requiredString(
    provenance.evidenceEnvironment,
    'external_intake_code_provenance_evidence_environment_invalid',
  );
  requiredString(
    provenance.evidenceClass,
    'external_intake_code_provenance_evidence_class_invalid',
  );
  return provenance;
}

export async function withCleanExternalIntakeCodeProvenance({
  workspaceRoot,
  codeProvenanceInspector = currentCodeProvenance,
  generate,
}) {
  if (typeof generate !== 'function') throw new Error('external_intake_generator_required');
  const capture = () => assertCleanExternalIntakeCodeProvenance(codeProvenanceInspector({
    workspaceRoot,
    allowReleaseCommitEnvironment: false,
  }));
  const provenance = capture();
  const assertProvenanceStillCurrent = () => {
    const current = capture();
    if (hashRecord('CodeProvenance', current) !== hashRecord('CodeProvenance', provenance)) {
      throw new Error('external_intake_code_provenance_changed_during_generation');
    }
    return current;
  };
  return generate(provenance, assertProvenanceStillCurrent);
}

export function finalizeExternalIntakeDocuments({ payloads, codeProvenance }) {
  const provenance = assertCleanExternalIntakeCodeProvenance(codeProvenance);
  if (!payloads || typeof payloads !== 'object' || Array.isArray(payloads)) {
    throw new Error('external_intake_payload_map_required');
  }
  const requiredNames = EXTERNAL_INTAKE_OUTPUT_SPECS.map(({ name }) => name);
  const suppliedNames = Object.keys(payloads).sort();
  const sortedRequiredNames = [...requiredNames].sort();
  if (suppliedNames.length !== requiredNames.length
    || suppliedNames.some((name, index) => name !== sortedRequiredNames[index])) {
    throw new Error('external_intake_payload_set_invalid');
  }
  const operationalTemplates = payloads['OPERATIONAL_RECEIPT_TEMPLATES.json'];
  if (operationalTemplates?.releaseCommit !== provenance.commit
    || !Array.isArray(operationalTemplates.templates)
    || operationalTemplates.templates.length === 0
    || operationalTemplates.templates.some((template) => (
      !template || typeof template !== 'object'
      || template.releaseCommit !== provenance.commit
    ))) {
    throw new Error('external_intake_operational_template_commit_mismatch');
  }
  const boundProvenance = Object.freeze({
    ...provenance,
    tags: Object.freeze([...provenance.tags]),
  });
  return Object.freeze(EXTERNAL_INTAKE_OUTPUT_SPECS.map(({ name, role }) => {
    const source = payloads[name];
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.kind !== 'string' || source.kind.length === 0
      || Object.hasOwn(source, 'documentHash')) {
      throw new Error(`external_intake_payload_invalid:${name}`);
    }
    const payload = Object.freeze({ ...source, codeProvenance: boundProvenance });
    return Object.freeze({
      name,
      role,
      document: Object.freeze({
        ...payload,
        documentHash: hashRecord(payload.kind, payload),
      }),
    });
  }));
}
