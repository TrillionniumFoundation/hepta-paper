import {
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-mutation-plan.mjs';
import {
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS,
} from '../../paper-adapters/automation/runtime-image-reproducibility-publication-mutation-plan.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS,
} from '../../paper-adapters/automation/full-research-qualification-publication-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-mutation-plan.mjs';
import {
  NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS,
} from '../../paper-adapters/automation/native-store-automation-runtime-reconciliation-mutation-plan.mjs';
import {
  NATIVE_STORE_CAMPAIGN_MUTATION_PLANS,
} from '../../paper-adapters/persistence/native-store-campaign-mutation-plan.mjs';
import {
  NATIVE_STORE_LEDGER_MUTATION_PLANS,
} from '../../paper-adapters/persistence/native-store-ledger-mutation-plan.mjs';
import {
  NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS,
} from '../../paper-adapters/persistence/native-store-online-mutation-plan.mjs';
import {
  NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS,
} from '../../paper-adapters/persistence/native-store-quality-release-mutation-plan.mjs';
import {
  NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS,
} from '../../paper-adapters/persistence/native-store-resource-workspace-mutation-plan.mjs';
import {
  NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS,
} from '../../paper-adapters/persistence/native-store-submission-delivery-mutation-plan.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-mutation-plan.mjs';

export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS = Object.freeze({
  ...AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS,
  ...AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS,
  ...AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS,
  ...AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
  ...AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS,
  ...RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS,
  ...FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS,
  ...AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS,
  ...NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS,
  ...NATIVE_STORE_CAMPAIGN_MUTATION_PLANS,
  ...NATIVE_STORE_LEDGER_MUTATION_PLANS,
  ...NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS,
  ...NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS,
  ...NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS,
  ...NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS,
  ...AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS,
});
