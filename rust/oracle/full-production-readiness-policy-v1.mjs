// Differential oracle for the pure full-production-readiness policy.
// Input is an array of {operation, ...} requests on stdin. The script keeps
// the incumbent Node implementation as the protocol authority and never
// performs package, provider, owner, or filesystem actions.
import fs from 'node:fs';
import {
  evaluateFullProductionReadiness,
  FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS,
  FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED,
  FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH,
  inspectPackageRetentionRecoveryReadinessResponse,
} from '../../paper-application/automation/full-production-readiness-policy.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(requests)) throw new Error('requests_array_required');
const results = requests.map((request) => {
  try {
    let value;
    if (request?.operation === 'inspect-package') {
      value = inspectPackageRetentionRecoveryReadinessResponse({
        response: request.response,
        observedAt: request.observedAt,
      });
    } else if (request?.operation === 'evaluate') {
      value = evaluateFullProductionReadiness(request.input);
    } else {
      throw new Error('unknown_policy_operation');
    }
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
process.stdout.write(JSON.stringify({
  profile: {node: process.version},
  constants: {
    ownerAcceptanceRequired: FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED,
    ownerFamilyManifestHash: FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH,
    operationalCapabilityIds: FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS,
  },
  results,
}));
