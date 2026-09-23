import { assertSubmissionConnectorPort } from '../../paper-ports/submission-connector-port.mjs';
import { verifySubmissionPortalBinding } from '../../paper-domain/submission/submission-portal-binding.mjs';

export function createSubmissionConnectorRouter({
  connectors = [],
} = {}) {
  if (!Array.isArray(connectors) || connectors.length === 0) {
    throw new Error('submission_connector_router_connectors_required');
  }
  const selected = connectors.map(assertSubmissionConnectorPort);
  if (new Set(selected.map((connector) => connector.connectorId)).size !== selected.length
    || new Set(selected.map((connector) => connector.connectorFamily)).size
      !== selected.length) {
    throw new Error('submission_connector_router_duplicate');
  }
  const byFamily = new Map(selected.map((connector) => [
    connector.connectorFamily, connector,
  ]));
  return Object.freeze({
    version: 1,
    kind: 'SubmissionConnectorRouter',
    connectorCount: selected.length,
    connectorFamilies: Object.freeze([...byFamily.keys()].sort()),
    resolve({
      baseTargetProfile,
      portalBinding,
      operation,
      observedAt,
      requireProductionEligible = false,
    } = {}) {
      if (!verifySubmissionPortalBinding(portalBinding, {
        baseTargetProfile,
        observedAt,
      })) {
        throw new Error('submission_connector_route_binding_invalid');
      }
      if (!portalBinding.enabledOperations.includes(operation)) {
        throw new Error(`submission_connector_route_operation_disabled:${operation}`);
      }
      const connector = byFamily.get(portalBinding.connectorFamily);
      if (!connector) {
        throw new Error(
          `submission_connector_route_implementation_missing:${portalBinding.connectorFamily}`,
        );
      }
      if (requireProductionEligible && connector.productionEligible !== true) {
        throw new Error(
          `submission_connector_route_not_production_eligible:${connector.connectorFamily}`,
        );
      }
      return connector;
    },
  });
}
