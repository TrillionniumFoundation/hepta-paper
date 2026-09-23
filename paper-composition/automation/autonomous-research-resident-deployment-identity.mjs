import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,191}$/;
const COMPONENT_KIND = 'AutonomousResearchPublicDeploymentComponentInspection';

export const AUTONOMOUS_RESEARCH_RESIDENT_PUBLIC_DEPLOYMENT_COMPONENTS =
  Object.freeze([
    'autonomous-submission-metadata-profile',
    'autonomous-submission-portal',
    'autonomous-venue-profile-registry',
    'empirical-plugin-runtime-scope',
    'external-qualification-process',
    'external-research-replay-service',
    'machine-intake',
    'online-mutation-authority',
    'prior-art-service',
    'provider',
    'research-author-identity',
    'research-execution-release-attestor',
    'reviewer-principal-pool',
    'runtime-image-reproducibility-process',
    'state-backup-authority',
    'topic-producer',
  ]);

function componentValid(component) {
  const keys = [
    'blockers', 'componentId', 'credentialBindingStatus',
    'environmentValuesRead', 'externalActionPerformed', 'inspectionHash', 'kind',
    'publicConfigurationHash', 'publicIdentityHash', 'publicTrustIdentityHash',
    'ready', 'secretMaterialRead', 'status', 'version',
  ];
  if (!exactKeys(component, keys) || component.version !== 1
    || component.kind !== COMPONENT_KIND
    || !SAFE_COMPONENT_ID.test(String(component.componentId || ''))
    || typeof component.ready !== 'boolean'
    || !['autonomous_research_public_deployment_component_ready',
      'autonomous_research_public_deployment_component_blocked']
      .includes(component.status)
    || component.ready !== (component.status
      === 'autonomous_research_public_deployment_component_ready')
    || (component.publicConfigurationHash !== null
      && !SHA256.test(String(component.publicConfigurationHash || '')))
    || (component.publicIdentityHash !== null
      && !SHA256.test(String(component.publicIdentityHash || '')))
    || (component.publicTrustIdentityHash !== null
      && !SHA256.test(String(component.publicTrustIdentityHash || '')))
    || !SHA256.test(String(component.inspectionHash || ''))
    || typeof component.credentialBindingStatus !== 'string'
    || !component.credentialBindingStatus
    || component.secretMaterialRead !== false
    || component.environmentValuesRead !== false
    || component.externalActionPerformed !== false
    || !Array.isArray(component.blockers)
    || component.blockers.some((blocker) => (
      !/^[a-z][a-z0-9_:-]{1,240}$/.test(String(blocker))
    ))
    || new Set(component.blockers).size !== component.blockers.length
    || component.ready !== (component.blockers.length === 0)
    || (component.ready && (!component.publicConfigurationHash
      || !component.publicIdentityHash))) return false;
  const { inspectionHash, ...payload } = component;
  return inspectionHash === hashRecord(
    'AutonomousResearchPublicDeploymentComponentInspection', payload,
  );
}

function canonicalRequiredComponents(values) {
  if (!Array.isArray(values) || values.length < 1
    || values.some((value) => !SAFE_COMPONENT_ID.test(String(value || '')))) {
    throw new Error('autonomous_research_resident_deployment_required_components_invalid');
  }
  const selected = [...new Set(values.map(String))].sort();
  if (selected.length !== values.length) {
    throw new Error('autonomous_research_resident_deployment_required_components_invalid');
  }
  return Object.freeze(selected);
}

export function inspectAutonomousResearchResidentDeploymentIdentity({
  components = [],
  requiredComponentIds = AUTONOMOUS_RESEARCH_RESIDENT_PUBLIC_DEPLOYMENT_COMPONENTS,
} = {}) {
  const required = canonicalRequiredComponents(requiredComponentIds);
  if (!Array.isArray(components) || components.some((component) => !componentValid(component))) {
    throw new Error('autonomous_research_resident_deployment_components_invalid');
  }
  const sorted = [...components].sort((left, right) => (
    left.componentId.localeCompare(right.componentId)
  ));
  if (new Set(sorted.map((component) => component.componentId)).size !== sorted.length) {
    throw new Error('autonomous_research_resident_deployment_component_duplicate');
  }
  const byId = new Map(sorted.map((component) => [component.componentId, component]));
  const blockers = [];
  for (const componentId of required) {
    const component = byId.get(componentId);
    if (!component) {
      blockers.push(`autonomous_research_resident_deployment_component_missing:${componentId}`);
    } else if (!component.ready) {
      blockers.push(...component.blockers.map((blocker) => (
        `autonomous_research_resident_deployment_component_blocked:${componentId}:${blocker}`
      )));
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)].sort());
  const componentIdentities = Object.freeze(required.map((componentId) => {
    const component = byId.get(componentId);
    return Object.freeze({
      componentId,
      publicIdentityHash: component?.publicIdentityHash || null,
    });
  }));
  const observedIdentityPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentObservedPublicDeploymentIdentity',
    components: componentIdentities,
  });
  const observedPublicDeploymentIdentityHash = hashRecord(
    'AutonomousResearchResidentObservedPublicDeploymentIdentity',
    observedIdentityPayload,
  );
  const ready = uniqueBlockers.length === 0;
  const residentDeploymentIdentityHash = ready
    ? hashRecord('AutonomousResearchResidentPublicDeploymentIdentity', {
      version: 1,
      components: componentIdentities,
    }) : null;
  const componentInspections = Object.freeze(required.map((componentId) => {
    const component = byId.get(componentId);
    return Object.freeze({
      componentId,
      ready: component?.ready === true,
      publicIdentityHash: component?.publicIdentityHash || null,
      inspectionHash: component?.inspectionHash || null,
      credentialBindingStatus: component?.credentialBindingStatus || 'unavailable',
      blockers: Object.freeze([...(component?.blockers || [])]),
    });
  }));
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentPublicDeploymentIdentityInspection',
    status: ready
      ? 'autonomous_research_resident_public_deployment_identity_ready'
      : 'autonomous_research_resident_public_deployment_identity_blocked',
    ready,
    requiredComponentIds: required,
    componentInspections,
    observedPublicDeploymentIdentityHash,
    residentDeploymentIdentityHash,
    secretMaterialRead: false,
    environmentValuesRead: false,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    inspectionHash: hashRecord(
      'AutonomousResearchResidentPublicDeploymentIdentityInspection', payload,
    ),
  });
}
