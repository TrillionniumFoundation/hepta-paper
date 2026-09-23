// Test-only original registry export. Production native composition embeds the
// actual fixed plan source and never evaluates Node during configuration.
import { AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS as plans } from '../../paper-composition/bootstrap/autonomous-research-online-mutation-operation-plans.mjs';
import { AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST as manifest } from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import { validateExternallyFencedSqliteMutationPlans } from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const checked = validateExternallyFencedSqliteMutationPlans({manifest, operationPlans: plans});
process.stdout.write(JSON.stringify({profile: productionOracleProfile(), manifest, plans,
  checked: {manifestHash: checked.manifestHash, byOperationId: Object.fromEntries(checked.byOperationId)}}));
