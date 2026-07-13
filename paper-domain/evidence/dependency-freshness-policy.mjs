import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function evaluateDependencyFreshness({ nodes = [] } = {}) {
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const blockers = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) { blockers.push(`evidence_dependency_cycle:${[...trail, id].join('>')}`); return; }
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) { blockers.push(`evidence_dependency_missing:${id}`); return; }
    visiting.add(id);
    for (const dependencyId of node.dependsOn || []) {
      const dependency = byId.get(String(dependencyId));
      if (!dependency) blockers.push(`evidence_dependency_missing:${id}:${dependencyId}`);
      else {
        visit(String(dependencyId), [...trail, id]);
        const boundHash = node.dependencyOutputHashes?.[dependencyId] || null;
        if (!boundHash || boundHash !== dependency.outputHash) blockers.push(`evidence_dependency_hash_stale:${id}:${dependencyId}`);
      }
    }
    if (!node.outputHash) blockers.push(`evidence_dependency_output_hash_missing:${id}`);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  const payload = { version: 1, kind: 'EvidenceDependencyFreshnessReport', status: blockers.length ? 'evidence_dependency_chain_stale' : 'evidence_dependency_chain_fresh', nodeCount: byId.size, blockers: [...new Set(blockers)] };
  return Object.freeze({ ...payload, evidenceDependencyFreshnessHash: hashRecord('EvidenceDependencyFreshnessReport', payload) });
}
