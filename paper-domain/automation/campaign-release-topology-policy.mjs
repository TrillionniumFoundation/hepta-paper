const PACKAGE_KINDS = new Set(['package', 'release-package']);

function isEmpiricalRun(node) {
  const kind = String(node?.kind || '');
  return /(?:^|-)empirical(?:-|$)/.test(kind) && !/(?:^|-)empirical-reproduce(?:-|$)/.test(kind);
}

function isEmpiricalReplay(node) {
  return /(?:^|-)empirical-reproduce(?:-|$)/.test(String(node?.kind || ''));
}

function unique(values) {
  return [...new Set(values)];
}

function sourceClosureTerminal(node) {
  return Boolean(node?.sourceClosureTerminal || node?.spec?.sourceClosureTerminal);
}

function sourceMutationForbidden(node) {
  return (node?.sourceMutationPolicy || node?.spec?.sourceMutationPolicy || null) === 'forbid';
}

export function evaluateCampaignReleaseTopology({ nodes = [] } = {}) {
  const blockers = [];
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [String(node?.nodeId || ''), node]));
  const packages = [...byId.values()].filter((node) => PACKAGE_KINDS.has(String(node?.kind || '')));
  const empiricalRuns = [...byId.values()].filter(isEmpiricalRun);
  const empiricalReplays = [...byId.values()].filter(isEmpiricalReplay);
  const formalVerifications = [...byId.values()].filter((node) => node?.kind === 'formal-verify');
  if (packages.length && empiricalRuns.length && !empiricalReplays.length) {
    blockers.push('campaign_release_empirical_replay_required');
  }
  if (packages.length) {
    for (const run of empiricalRuns) {
      if (!empiricalReplays.some((replay) => (replay.dependencies || []).map(String).includes(String(run.nodeId)))) {
        blockers.push(`campaign_release_empirical_run_replay_missing:${run.nodeId}`);
      }
    }
    for (const replay of empiricalReplays) {
      if (!(replay.dependencies || []).map(String).some((dependency) => empiricalRuns.some((run) => String(run.nodeId) === dependency))) {
        blockers.push(`campaign_release_empirical_replay_run_dependency_missing:${replay.nodeId}`);
      }
    }
  }
  const packageTopologies = [];
  for (const packageNode of packages) {
    const dependencies = unique((packageNode.dependencies || []).map(String));
    const direct = dependencies.map((dependency) => byId.get(dependency)).filter(Boolean);
    const finalCompileNodes = direct.filter((node) => node.kind === 'final-compile');
    const researchVerifyNodes = direct.filter((node) => node.kind === 'research-verify');
    if (finalCompileNodes.length !== 1) blockers.push(`campaign_release_final_compile_dependency_invalid:${packageNode.nodeId}`);
    if (researchVerifyNodes.length !== 1) blockers.push(`campaign_release_research_dependency_invalid:${packageNode.nodeId}`);
    const finalCompileNode = finalCompileNodes[0] || null;
    const researchVerifyNode = researchVerifyNodes[0] || null;
    if (finalCompileNode && researchVerifyNode
      && !(researchVerifyNode.dependencies || []).map(String).includes(String(finalCompileNode.nodeId))) {
      blockers.push(`campaign_release_research_final_compile_dependency_missing:${packageNode.nodeId}`);
    }
    const researchDependencies = new Set((researchVerifyNode?.dependencies || []).map(String));
    for (const formalVerification of formalVerifications) {
      if (!researchDependencies.has(String(formalVerification.nodeId))) {
        blockers.push(`campaign_release_research_formal_verification_dependency_missing:${packageNode.nodeId}:${formalVerification.nodeId}`);
      }
    }
    for (const replay of empiricalReplays) {
      if (!researchDependencies.has(String(replay.nodeId))) {
        blockers.push(`campaign_release_research_empirical_replay_dependency_missing:${packageNode.nodeId}:${replay.nodeId}`);
      }
    }
    const sourceClosureFormal = formalVerifications.filter(sourceClosureTerminal);
    const sourceClosureReplays = empiricalReplays.filter(sourceClosureTerminal);
    if (formalVerifications.length) {
      if (sourceClosureFormal.length !== 1) {
        blockers.push(`campaign_release_formal_source_closure_invalid:${packageNode.nodeId}`);
      } else if (!finalCompileNode?.dependencies?.map(String).includes(String(sourceClosureFormal[0].nodeId))) {
        blockers.push(`campaign_release_final_compile_formal_source_closure_dependency_missing:${packageNode.nodeId}`);
      }
    }
    if (empiricalRuns.length) {
      if (!sourceClosureReplays.length) {
        blockers.push(`campaign_release_empirical_source_closure_missing:${packageNode.nodeId}`);
      }
      for (const replay of sourceClosureReplays) {
        const sealedOriginals = (replay.dependencies || []).map(String)
          .map((dependency) => byId.get(dependency))
          .filter((candidate) => candidate && isEmpiricalRun(candidate) && sourceClosureTerminal(candidate));
        if (sealedOriginals.length !== 1 || !sourceMutationForbidden(replay)
          || !sourceMutationForbidden(sealedOriginals[0])) {
          blockers.push(`campaign_release_empirical_source_closure_not_sealed:${replay.nodeId}`);
        }
        if (!finalCompileNode?.dependencies?.map(String).includes(String(replay.nodeId))) {
          blockers.push(`campaign_release_final_compile_empirical_source_closure_dependency_missing:${packageNode.nodeId}:${replay.nodeId}`);
        }
      }
    }
    if ((formalVerifications.length || empiricalRuns.length)
      && (!sourceClosureTerminal(finalCompileNode) || !sourceMutationForbidden(finalCompileNode))) {
      blockers.push(`campaign_release_final_compile_source_closure_not_sealed:${packageNode.nodeId}`);
    }
    packageTopologies.push(Object.freeze({ packageNode, finalCompileNode, researchVerifyNode }));
  }
  return Object.freeze({
    status: blockers.length ? 'campaign_release_topology_blocked' : 'campaign_release_topology_verified',
    releasePackagingPresent: packages.length > 0,
    researchVerificationRequired: packages.length > 0,
    packageTopologies: Object.freeze(packageTopologies),
    blockers: Object.freeze(unique(blockers)),
  });
}

export function evaluatePackageResearchTopology({ nodes = [], packageNode = null } = {}) {
  const topology = evaluateCampaignReleaseTopology({ nodes });
  const selected = topology.packageTopologies.find((item) => item.packageNode.nodeId === packageNode?.nodeId) || null;
  return Object.freeze({ ...topology, selected });
}
