export function assertAutonomousVenueComplianceInspectorPort(value) {
  if (!value || value.kind !== 'AutonomousVenueComplianceInspector'
    || typeof value.inspect !== 'function') {
    throw new Error('AutonomousVenueComplianceInspectorPort is required');
  }
  return value;
}
