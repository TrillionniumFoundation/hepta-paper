export const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const IDENTIFIER = /^[a-z][a-z0-9-]{2,127}$/;
export const QUALIFICATION_PAPER_ID_ASSERTION = '@qualification-paper-id';
export const ONLINE_TRANSITION_ID_ASSERTION = '@online-transition-id';
export const STRICT_FULL_AUTO_ACCEPTANCE_NUMERICAL_FAMILIES = Object.freeze([
  'econometrics_panel_benchmark',
  'finance_asset_pricing_benchmark',
  'ml_algorithm_benchmark',
  'operations_optimization_benchmark',
  'registered_scalar_response_benchmark',
  'rl_stochastic_control_benchmark',
]);

export const STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER = Object.freeze([
  'state-provisioning',
  'migration',
  'online-transition',
  'runtime-reproducibility',
  'advanced-numeric-activation',
  'provider-canaries',
  'external-qualifier',
  'release-attestor-challenge',
  'machine-intake',
  'resident-supervisor',
  'golden-qualification',
  'production-campaign-qualification',
  'generic-domain-capability-convergence',
  'restore-drill',
  'submission-dispatcher',
]);

// These completed-plan actions are explicitly bounded to operations whose child
// contracts are repeatable and whose result is independently verified before
// another action is attempted.  Steps omitted here must never be replayed merely
// because live readiness became stale.
export const STRICT_FULL_AUTO_ACCEPTANCE_COMPLETE_RENEWAL_STEP_ORDER = Object.freeze([
  'online-transition',
  'runtime-reproducibility',
  'provider-canaries',
  'external-qualifier',
  'release-attestor-challenge',
  'machine-intake',
  'resident-supervisor',
  'golden-qualification',
  'production-campaign-qualification',
  'generic-domain-capability-convergence',
  'restore-drill',
  'submission-dispatcher',
]);

export const STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY = Object.freeze({
  'research-author-credential-root': 'opaque-directory-reference',
  'research-author-identity-config': 'public-reference',
  'online-state-authority-principal': 'public-reference',
  'online-state-authority-process-config': 'public-reference',
  'runtime-reproducibility-principal': 'public-reference',
  'formal-sandbox-runtime-config': 'public-reference',
  'production-mathlib-build-authority-config': 'public-reference',
  'empirical-plugin-signing-config': 'private-configuration-reference',
  'empirical-plugin-trust-store': 'public-reference',
  'empirical-plugin-signer-command': 'public-reference',
  'external-qualifier-principal': 'public-reference',
  'prior-art-service-config': 'public-reference',
  'prior-art-service-credential-reference': 'opaque-secret-reference',
  'external-replay-config': 'public-reference',
  'external-replay-credential-reference': 'opaque-secret-reference',
  'release-attestor-config': 'private-configuration-reference',
  'release-attestor-signer-credential-root': 'opaque-directory-reference',
  'release-attestor-probe-credential-root': 'opaque-directory-reference',
  'release-attestor-signer-command': 'public-reference',
  'release-attestor-probe-command': 'public-reference',
  'owner-trust-store': 'public-reference',
  'owner-acceptance-document': 'public-reference',
  'package-recovery-readiness-command': 'public-reference',
  'machine-intake-principal': 'public-reference',
  'topic-producer-profile': 'public-reference',
  'backup-restore-authority-principal': 'public-reference',
  'submission-dispatcher-principal': 'public-reference',
  'autonomous-venue-profile-config': 'public-reference',
  'autonomous-submission-metadata-config': 'public-reference',
  'submission-portal-descriptor-config': 'public-reference',
});

export const PRINCIPAL_REFERENCE_IDS = Object.freeze(Object.keys(
  STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
).filter((id) => id.endsWith('-principal')));

export const STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID =
  'final-aggregate-live-verification';

export const CORE_PRINCIPAL_ENVIRONMENT_REFERENCES = Object.freeze({
  HEPTA_RESEARCH_AUTHOR_CODEX_HOME: 'research-author-credential-root',
  HEPTA_FORMAL_REVIEW_CODEX_HOME: 'research-author-credential-root',
});

export const READINESS_ENVIRONMENT_REFERENCES = Object.freeze({
  ...CORE_PRINCIPAL_ENVIRONMENT_REFERENCES,
  HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: 'machine-intake-principal',
  HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE: 'topic-producer-profile',
  HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG:
    'online-state-authority-principal',
  HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG:
    'online-state-authority-process-config',
  HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG:
    'backup-restore-authority-principal',
  HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG: 'external-qualifier-principal',
  HEPTA_PRIOR_ART_SERVICE_CONFIG: 'prior-art-service-config',
  // The service configuration itself is not enough to establish a pinned
  // production identity.  Pass the document's canonical configuration hash
  // through the plan-bound child environment so the adapter cannot silently
  // downgrade to its bounded, unpinned mode.
  HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH: 'prior-art-service-config',
  HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE: 'prior-art-service-credential-reference',
  HEPTA_EXTERNAL_REPLAY_CONFIG: 'external-replay-config',
  // External replay has the same explicit out-of-band hash requirement.  A
  // missing binding must remain a hard blocker instead of relying on ambient
  // process environment state.
  HEPTA_EXTERNAL_REPLAY_CONFIG_HASH: 'external-replay-config',
  HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE: 'external-replay-credential-reference',
  HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: 'research-author-identity-config',
  HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH: 'research-author-identity-config',
  HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: 'release-attestor-config',
  HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH: 'release-attestor-config',
  HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG: 'runtime-reproducibility-principal',
  HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH: 'runtime-reproducibility-principal',
  HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG: 'formal-sandbox-runtime-config',
  HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG_HASH: 'formal-sandbox-runtime-config',
  HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG:
    'production-mathlib-build-authority-config',
  HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH:
    'production-mathlib-build-authority-config',
  HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: 'autonomous-venue-profile-config',
  HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH: 'autonomous-venue-profile-config',
  HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG: 'autonomous-submission-metadata-config',
  HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH:
    'autonomous-submission-metadata-config',
  HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG:
    'submission-portal-descriptor-config',
  HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
    'submission-portal-descriptor-config',
  HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
    'submission-portal-descriptor-config',
  HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: 'submission-dispatcher-principal',
});

const SUBMISSION_PORTAL_ENVIRONMENT_REFERENCES = Object.freeze({
  HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG:
    'submission-portal-descriptor-config',
  HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
    'submission-portal-descriptor-config',
  HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
    'submission-portal-descriptor-config',
});

export const STEP_INVOCATION_POLICY = Object.freeze({
  'state-provisioning': Object.freeze({
    execute: Object.freeze({
      command: 'autonomous-state-provision',
      requiredArguments: ['--action', 'execute', '--execute', '--plan-id'],
      requiredFlagValues: { '--action': 'execute' },
      requiredSha256ValueFlags: ['--plan-id'],
      idempotencyValueFlag: '--plan-id',
      argumentReferenceFlags: {
        '--machine-intake-config': 'machine-intake-principal',
        '--topic-producer-profile': 'topic-producer-profile',
      },
      environmentReferences: {
        ...CORE_PRINCIPAL_ENVIRONMENT_REFERENCES,
        HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: 'machine-intake-principal',
      },
      assertions: [['/status', 'autonomous_research_state_business_schemas_provisioned']],
    }),
    verify: Object.freeze({
      command: 'autonomous-online-transition',
      requiredArguments: ['--action', 'plan', '--authority-process-config'],
      requiredFlagValues: { '--action': 'plan' },
      argumentReferenceFlags: {
        '--authority-process-config': 'online-state-authority-process-config',
      },
      environmentReferences: {},
      assertions: [
        ['/ready', true],
        ['/plan/transitionId', ONLINE_TRANSITION_ID_ASSERTION],
      ],
    }),
  }),
  migration: Object.freeze({
    execute: Object.freeze({ command: 'store', requiredArguments: ['migrate'],
      environmentReferences: {}, assertions: [['/status', 'hepta_native_store_ready']],
      exactArguments: true }),
    verify: Object.freeze({ command: 'store',
      requiredArguments: ['status', '--require-trust-clean', '--allow-isolated-verification-evidence'],
      environmentReferences: {}, assertions: [['/status', 'hepta_native_store_ready']],
      exactArguments: true }),
  }),
  'online-transition': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-online-transition',
      requiredArguments: ['--action', 'execute', '--execute', '--transition-id'],
      requiredFlagValues: { '--action': 'execute' }, requiredSha256ValueFlags: ['--transition-id'],
      idempotencyValueFlag: '--transition-id',
      argumentReferenceFlags: {
        '--authority-process-config': 'online-state-authority-process-config',
      }, environmentReferences: {},
      assertions: [['/status', 'autonomous_research_online_schema_transition_ready']] }),
    verify: Object.freeze({ command: 'automation-status', requiredArguments: [],
      exactArguments: true, environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [
        ['/autonomousStateDatabaseInventoryReady', true],
        ['/autonomousStateOnlineAntiRollbackReady', true],
      ] }),
  }),
  'runtime-reproducibility': Object.freeze({
    execute: Object.freeze({ command: 'runtime-image-reproducibility',
      requiredArguments: ['--action', 'publish'], requiredFlagValues: { '--action': 'publish' },
      argumentReferenceFlags: { '--config': 'runtime-reproducibility-principal' },
      // The verifier refuses to read or invoke an unpinned process
      // configuration. Bind its resolved identity hash from the plan
      // reference instead of inheriting an ambient value.
      environmentReferences: {
        HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH:
          'runtime-reproducibility-principal',
      },
      assertions: [['/status', 'runtime_image_reproducibility_verified']] }),
    verify: Object.freeze({ command: 'runtime-image-reproducibility',
      requiredArguments: ['--action', 'status'], requiredFlagValues: { '--action': 'status' },
      argumentReferenceFlags: { '--config': 'runtime-reproducibility-principal' },
      environmentReferences: {
        HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH:
          'runtime-reproducibility-principal',
      },
      assertions: [['/status', 'runtime_image_reproducibility_verified']] }),
  }),
  'advanced-numeric-activation': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-empirical-plugin-release',
      requiredArguments: ['--action', 'publish'], requiredFlagValues: { '--action': 'publish' },
      repeatableValueFlags: ['--benchmark-family'],
      requiredRepeatedFlagValues: {
        '--benchmark-family': STRICT_FULL_AUTO_ACCEPTANCE_NUMERICAL_FAMILIES,
      },
      argumentReferenceFlags: { '--signing-config': 'empirical-plugin-signing-config' },
      environmentReferences: {},
      assertions: [['/status', 'autonomous_empirical_plugin_release_published'],
        ['/strictProductionAdvancedNumericalFamilySetVerified', true]] }),
    verify: Object.freeze({ command: 'autonomous-empirical-plugin-release',
      requiredArguments: ['--action', 'inspect'], requiredFlagValues: { '--action': 'inspect' },
      environmentReferences: {},
      assertions: [['/status', 'autonomous_empirical_plugin_installed_release_ready'],
        ['/activationPointerVerified', true],
        ['/strictProductionAdvancedNumericalFamilySetVerified', true]] }),
  }),
  'provider-canaries': Object.freeze({
    execute: Object.freeze({ command: 'automation-status',
      requiredArguments: ['--live-provider-canary'], exactArguments: true,
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/liveProviderCanaryReady', true]] }),
    verify: Object.freeze({ command: 'automation-status',
      requiredArguments: ['--live-provider-canary'], exactArguments: true,
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/liveProviderCanaryReady', true]] }),
  }),
  'external-qualifier': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-research',
      requiredArguments: ['--action', 'prepare', '--launch-mode', 'golden-bootstrap', '--paper-id'],
      requiredFlagValues: { '--action': 'prepare', '--launch-mode': 'golden-bootstrap' },
      requiredValueFlags: ['--paper-id'],
      argumentReferenceFlags: { '--external-qualification-config': 'external-qualifier-principal' },
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/externalQualificationServiceReady', true],
        ['/campaign/paperId', QUALIFICATION_PAPER_ID_ASSERTION]] }),
    verify: Object.freeze({ command: 'autonomous-research',
      requiredArguments: ['--action', 'prepare', '--launch-mode', 'golden-bootstrap', '--paper-id'],
      requiredFlagValues: { '--action': 'prepare', '--launch-mode': 'golden-bootstrap' },
      requiredValueFlags: ['--paper-id'],
      argumentReferenceFlags: { '--external-qualification-config': 'external-qualifier-principal' },
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/externalQualificationServiceReady', true],
        ['/campaign/paperId', QUALIFICATION_PAPER_ID_ASSERTION]] }),
  }),
  'release-attestor-challenge': Object.freeze({
    execute: Object.freeze({ command: 'automation-status',
      requiredArguments: ['--live-release-attestor'], exactArguments: true,
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/researchExecutionReleaseAttestorProductionReady', true]] }),
    verify: Object.freeze({ command: 'automation-status',
      requiredArguments: ['--live-release-attestor'], exactArguments: true,
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/researchExecutionReleaseAttestorProductionReady', true]] }),
  }),
  'machine-intake': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-supervisor',
      requiredArguments: [
        '--request-resident-cycle', '--publish-strict-machine-intake-reconciliation',
      ],
      exactArguments: true,
      environmentReferences: {},
      assertions: [['/status', 'autonomous_research_resident_cycle_completed']] }),
    verify: Object.freeze({ command: 'autonomous-supervisor-health',
      requiredArguments: ['--require-strict-machine-intake-reconciliation'], exactArguments: true,
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/strictMachineIntakeReconciliationReady', true]] }),
  }),
  'resident-supervisor': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-supervisor-health',
      requiredArguments: ['--require-startup-reconciliation'], exactArguments: true,
      environmentReferences: {},
      assertions: [['/status', 'autonomous_research_supervisor_instance_ready']] }),
    verify: Object.freeze({ command: 'autonomous-supervisor-health',
      requiredArguments: ['--require-startup-reconciliation'], exactArguments: true,
      environmentReferences: {},
      assertions: [['/status', 'autonomous_research_supervisor_instance_ready']] }),
  }),
  'golden-qualification': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-research',
      requiredArguments: ['--action', 'converge', '--launch-mode', 'golden-bootstrap', '--paper-id',
        '--require-bounded-golden-ready'],
      requiredFlagValues: { '--action': 'converge', '--launch-mode': 'golden-bootstrap' },
      requiredValueFlags: ['--paper-id'],
      argumentReferenceFlags: { '--external-qualification-config': 'external-qualifier-principal' },
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/boundedGoldenQualificationPublished', true],
        ['/campaign/paperId', QUALIFICATION_PAPER_ID_ASSERTION]] }),
    verify: Object.freeze({ command: 'automation-status', requiredArguments: [],
      exactArguments: true, environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/boundedGoldenInfrastructureQualificationReady', true],
        ['/fullResearchQualification/paperId', QUALIFICATION_PAPER_ID_ASSERTION]] }),
  }),
  'production-campaign-qualification': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-supervisor',
      requiredArguments: ['--request-resident-cycle'], exactArguments: true,
      environmentReferences: {},
      assertions: [['/status', 'autonomous_research_resident_cycle_completed']] }),
    verify: Object.freeze({ command: 'automation-status', requiredArguments: [],
      exactArguments: true, environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [
        ['/autonomousResearchAgendaAuthorityInspection/ready', true],
        ['/autonomousResearchAgendaAuthorityInspection/priorArtClaimAlignmentReady', true],
        ['/autonomousResearchAgendaAuthorityInspection/paperId', QUALIFICATION_PAPER_ID_ASSERTION],
        ['/experimentIrExecutionAuthorityInspection/ready', true],
        ['/experimentIrExecutionAuthorityInspection/paperId', QUALIFICATION_PAPER_ID_ASSERTION],
        ['/autonomousResearchVenueRequirementAuthorityInspection/ready', true],
        ['/autonomousResearchVenueRequirementAuthorityInspection/paperId', QUALIFICATION_PAPER_ID_ASSERTION],
        ['/autonomousResearchAssuranceAuthorityInspection/ready', true],
        ['/autonomousResearchAssuranceAuthorityInspection/paperId', QUALIFICATION_PAPER_ID_ASSERTION],
      ] }),
  }),
  'generic-domain-capability-convergence': Object.freeze({
    execute: Object.freeze({ command: 'generic-domain-capability-evidence',
      requiredArguments: ['--action', 'converge', '--paper-id'],
      requiredFlagValues: { '--action': 'converge' }, requiredValueFlags: ['--paper-id'],
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/ready', true], ['/snapshotCurrent', true],
        ['/paperId', QUALIFICATION_PAPER_ID_ASSERTION]] }),
    verify: Object.freeze({ command: 'generic-domain-capability-evidence',
      requiredArguments: ['--action', 'status', '--paper-id'],
      requiredFlagValues: { '--action': 'status' }, requiredValueFlags: ['--paper-id'],
      environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/ready', true], ['/paperBound', true], ['/snapshotCurrent', true],
        ['/paperId', QUALIFICATION_PAPER_ID_ASSERTION]] }),
  }),
  'restore-drill': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-state-backup',
      requiredArguments: ['--action', 'restore-drill'],
      requiredFlagValues: { '--action': 'restore-drill' },
      argumentReferenceFlags: { '--authority-config': 'backup-restore-authority-principal' },
      environmentReferences: {},
      assertions: [['/status', 'autonomous_research_state_restore_drill_passed']] }),
    verify: Object.freeze({ command: 'automation-status', requiredArguments: [],
      exactArguments: true, environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
      assertions: [['/autonomousStateLatestValidRestoreDrillReady', true]] }),
  }),
  'submission-dispatcher': Object.freeze({
    execute: Object.freeze({ command: 'autonomous-submission-dispatcher-challenge',
      requiredArguments: ['--action', 'publish', '--plan-hash', '@acceptance-plan-hash',
        '--idempotency-key', '--portal-id', '--portal-configuration-hash',
        '--portal-descriptor-hash'], requiredFlagValues: { '--action': 'publish' },
      planHashValueFlag: '--plan-hash', idempotencyValueFlag: '--idempotency-key',
      environmentReferences: SUBMISSION_PORTAL_ENVIRONMENT_REFERENCES,
      assertions: [['/ready', true]] }),
    verify: Object.freeze({ command: 'autonomous-submission-dispatcher-challenge',
      requiredArguments: ['--action', 'status', '--plan-hash', '@acceptance-plan-hash',
        '--idempotency-key', '--portal-id', '--portal-configuration-hash',
        '--portal-descriptor-hash'], requiredFlagValues: { '--action': 'status' },
      planHashValueFlag: '--plan-hash', idempotencyValueFlag: '--idempotency-key',
      environmentReferences: {
        ...SUBMISSION_PORTAL_ENVIRONMENT_REFERENCES,
        HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH: 'submission-dispatcher-principal',
      }, assertions: [['/ready', true], ['/portalBindingVerified', true],
        ['/portalConfigurationIdentityPinned', true], ['/portalDescriptorPinned', true],
        ['/portalFullProductionReady', true], ['/livePortalCanaryVerified', true],
        ['/livePortalCanaryAuthorityIndependentFromDispatcher', true]] }),
  }),
});

export const FINAL_VERIFICATION_INVOCATION_POLICY = Object.freeze({
  command: 'full-production-readiness',
  requiredArguments: [
    '--owner-trust-store',
    '--owner-trust-store-sha256',
    '--owner-acceptance-document',
    '--owner-acceptance-document-sha256',
    '--package-recovery-readiness-command',
    '--package-recovery-readiness-command-sha256',
    '--live-provider-canary',
    '--live-release-attestor',
    '--require-full-production',
  ],
  requiredSha256ValueFlags: [
    '--owner-trust-store-sha256',
    '--owner-acceptance-document-sha256',
    '--package-recovery-readiness-command-sha256',
  ],
  argumentReferenceFlags: {
    '--owner-trust-store': 'owner-trust-store',
    '--owner-acceptance-document': 'owner-acceptance-document',
    '--package-recovery-readiness-command': 'package-recovery-readiness-command',
  },
  argumentReferenceHashFlags: {
    '--owner-trust-store-sha256': 'owner-trust-store',
    '--owner-acceptance-document-sha256': 'owner-acceptance-document',
    '--package-recovery-readiness-command-sha256': 'package-recovery-readiness-command',
  },
  environmentReferences: READINESS_ENVIRONMENT_REFERENCES,
  assertions: [
    ['/fullyAutonomousResearchSystemStatus',
      'generic_domain_autonomous_research_system_ready'],
    ['/runtimeImageReproducibilityReady', true],
    ['/runtimeImageReproducibility/requiredProfiles', ['python', 'pythonGpu', 'r']],
    ['/gpuScientificRuntimeReady', true],
    ['/gpuPdeOperationalProofReady', true],
    ['/gpuPdeProductionQualificationReady', true],
    ['/gpuDeepLearningOperationalProofReady', true],
    ['/gpuDeepLearningProductionQualificationReady', true],
    ['/fullResearchQualification/paperId', QUALIFICATION_PAPER_ID_ASSERTION],
    ['/fullProductionStatus', 'full_production_ready'],
    ['/fullProductionReady', true],
    ['/packageRetentionRecoveryReady', true],
    ['/offhostWormCustodyReady', true],
    ['/independentExternalOwnerAcceptanceReady', true],
    ['/independentProductionOperationalProofReady', true],
    ['/blockers', []],
  ],
});

export const FORBIDDEN_INVOCATION_ARGUMENTS = new Set(['--help', '-h', '--root', '--runtime-root']);
export const STEP_ARGUMENT_GRAMMAR = Object.freeze({
  'state-provisioning': Object.freeze({
    execute: Object.freeze({
      booleanFlags: ['--execute'],
      valueFlags: ['--action', '--plan-id', '--machine-intake-config',
        '--topic-producer-profile', '--dataset-root',
        '--runtime-reproducibility-maximum-attempts-per-epoch',
        '--runtime-reproducibility-maximum-cost-usd-per-epoch'],
    }),
    verify: Object.freeze({ booleanFlags: [],
      valueFlags: ['--action', '--authority-process-config'] }),
  }),
  migration: Object.freeze({ execute: null, verify: null }),
  'online-transition': Object.freeze({
    execute: Object.freeze({ booleanFlags: ['--execute'],
      valueFlags: ['--action', '--transition-id', '--authority-process-config'] }),
    verify: Object.freeze({ booleanFlags: [], valueFlags: [] }),
  }),
  'runtime-reproducibility': Object.freeze({
    execute: Object.freeze({ booleanFlags: [], valueFlags: ['--action', '--config', '--receipt'] }),
    verify: Object.freeze({ booleanFlags: [], valueFlags: ['--action', '--config', '--receipt'] }),
  }),
  'advanced-numeric-activation': Object.freeze({
    execute: Object.freeze({ booleanFlags: [],
      valueFlags: ['--action', '--activation', '--signing-config', '--install-root',
        '--package-version', '--benchmark-family'] }),
    verify: Object.freeze({ booleanFlags: [], valueFlags: ['--action', '--activation'] }),
  }),
  'provider-canaries': Object.freeze({
    execute: Object.freeze({ booleanFlags: ['--live-provider-canary'], valueFlags: [] }),
    verify: Object.freeze({ booleanFlags: ['--live-provider-canary'], valueFlags: [] }),
  }),
  'external-qualifier': Object.freeze({
    execute: Object.freeze({ booleanFlags: [],
      valueFlags: ['--action', '--launch-mode', '--paper-id',
        '--external-qualification-config'] }),
    verify: Object.freeze({ booleanFlags: [],
      valueFlags: ['--action', '--launch-mode', '--paper-id',
        '--external-qualification-config'] }),
  }),
  'release-attestor-challenge': Object.freeze({
    execute: Object.freeze({ booleanFlags: ['--live-release-attestor'], valueFlags: [] }),
    verify: Object.freeze({ booleanFlags: ['--live-release-attestor'], valueFlags: [] }),
  }),
  'machine-intake': Object.freeze({
    execute: Object.freeze({
      booleanFlags: [
        '--request-resident-cycle', '--publish-strict-machine-intake-reconciliation',
      ],
      valueFlags: [] }),
    verify: Object.freeze({
      booleanFlags: ['--require-strict-machine-intake-reconciliation'], valueFlags: [] }),
  }),
  'resident-supervisor': Object.freeze({
    execute: Object.freeze({ booleanFlags: ['--require-startup-reconciliation'], valueFlags: [] }),
    verify: Object.freeze({ booleanFlags: ['--require-startup-reconciliation'], valueFlags: [] }),
  }),
  'golden-qualification': Object.freeze({
    execute: Object.freeze({ booleanFlags: ['--require-bounded-golden-ready'],
      valueFlags: ['--action', '--launch-mode', '--paper-id',
        '--external-qualification-config'] }),
    verify: Object.freeze({ booleanFlags: [], valueFlags: [] }),
  }),
  'production-campaign-qualification': Object.freeze({
    execute: Object.freeze({ booleanFlags: ['--request-resident-cycle'],
      valueFlags: [] }),
    verify: Object.freeze({ booleanFlags: [], valueFlags: [] }),
  }),
  'generic-domain-capability-convergence': Object.freeze({
    execute: Object.freeze({ booleanFlags: [], valueFlags: ['--action', '--paper-id'] }),
    verify: Object.freeze({ booleanFlags: [], valueFlags: ['--action', '--paper-id'] }),
  }),
  'restore-drill': Object.freeze({
    execute: Object.freeze({ booleanFlags: [],
      valueFlags: ['--action', '--authority-config', '--bundle'] }),
    verify: Object.freeze({ booleanFlags: [], valueFlags: [] }),
  }),
  'submission-dispatcher': Object.freeze({
    execute: Object.freeze({ booleanFlags: [],
      valueFlags: ['--action', '--plan-hash', '--idempotency-key', '--portal-id',
        '--portal-configuration-hash', '--portal-descriptor-hash'] }),
    verify: Object.freeze({ booleanFlags: [],
      valueFlags: ['--action', '--plan-hash', '--idempotency-key', '--portal-id',
        '--portal-configuration-hash', '--portal-descriptor-hash'] }),
  }),
});

export const FINAL_VERIFICATION_ARGUMENT_GRAMMAR = Object.freeze({
  booleanFlags: [
    '--live-provider-canary', '--live-release-attestor', '--require-full-production',
  ],
  valueFlags: [
    '--owner-trust-store',
    '--owner-trust-store-sha256',
    '--owner-acceptance-document',
    '--owner-acceptance-document-sha256',
    '--package-recovery-readiness-command',
    '--package-recovery-readiness-command-sha256',
  ],
});

export const ABSOLUTE_PATH_FLAGS = new Set([
  '--activation', '--authority-config', '--authority-process-config', '--bundle', '--config',
  '--dataset-root', '--external-qualification-config', '--install-root',
  '--machine-intake-config', '--receipt', '--signing-config', '--topic-producer-profile',
  '--owner-trust-store', '--owner-acceptance-document',
  '--package-recovery-readiness-command',
]);
