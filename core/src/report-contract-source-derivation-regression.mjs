import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_REPORT_FILE_ID = 'report-contract-source-derivation-regression-latest.json';
export const REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_SCRIPT_ID = 'reports:contract-source-derivation-regression';
export const REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_STEP_ID = 'report_contract_source_derivation_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_syntax_coverage_regression';
const SECTION_CORE_SOURCE_PATH = 'src/report-contract-doc-page-section-regression-core.mjs';
const SECTION_CORE_IMPORT_SNIPPET = "from './report-contract-doc-page-section-regression-core.mjs'";
const SECTION_CORE_REQUIRED_HELPERS = Object.freeze([
  'buildSentenceSectionHeading',
  'buildSentenceSectionMarkdownBlock',
  'buildSentenceSectionRegressionInput',
  'buildSentenceSectionRegressionReport',
  'buildSentenceSectionRegressionScenarios',
  'summarizeSentenceSectionRegressionReport',
]);
const SECTION_CORE_PRIVATE_IMPLEMENTATION_SNIPPETS = Object.freeze([
  'function docsPathFor(',
  'function extractReleasePostAction',
  'function replaceReleasePostAction',
  'function mutateTargetDocsSection(',
  'function expectedPartsFor(',
  'function presenceKey(',
  'function countPresent(',
  'function analyzeContract(',
  'function analyzeDocPageReleasePostAction',
  'function compactAnalysis(',
  'function runScenario(',
]);

const POST_ACTION_SECTION_CORE_EXPECTATIONS = Object.freeze([
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_receipt_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_audit_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_reconciliation_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_settlement_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_acceptance_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_payment_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_deployment_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_provider_spend_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_state_transition_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([
      'appliesLocalQueueConsumption',
    ]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_background_runner_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([
      'appliesLocalQueueConsumption',
      'appliesLocalBackgroundRunner',
      'runsBackgroundRunner',
    ]),
  }),
  Object.freeze({
    contractId: 'report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression',
    requiredExtraSafetyFlags: Object.freeze([
      'appliesLocalQueueConsumption',
      'appliesLocalBackgroundRunner',
      'runsBackgroundRunner',
      'appliesLocalDispatchCompletion',
      'runsDispatchCompletion',
    ]),
  }),
]);

export const REPORT_CONTRACT_SOURCE_DERIVATION_DOC_OVERRIDES = Object.freeze({
  integration_gate_sequence_regression: 'docs/integration-gate-sequence-regression.md',
  report_freshness_regression: 'docs/report-freshness.md',
});

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_derived_files',
    label: 'A new manifest contract is added with canonical ids but without its source/docs files',
    expectedBlockerCode: 'report_contract_source_derivation_source_file_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_derivation_guard',
        label: 'Report future derivation guard',
        scriptId: 'reports:future-derivation-guard',
        exporterPath: 'src/export-report-future-derivation-guard.mjs',
        stepIds: ['report_future_derivation_guard_export'],
        fileId: 'report-future-derivation-guard-latest.json',
        stdoutHashField: 'futureDerivationGuardHash',
        gateSummaryHashKey: 'reportFutureDerivationGuardHash',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'exporter_path_drift',
    label: 'A contract exporter path drifts away from the contract id',
    expectedBlockerCode: 'report_contract_source_derivation_exporter_path_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      contract.exporterPath = 'src/export-report-contract-source-derivation-mistyped.mjs';
    },
  }),
  Object.freeze({
    scenarioId: 'file_id_drift',
    label: 'A latest JSON file id drifts away from the contract id',
    expectedBlockerCode: 'report_contract_source_derivation_file_id_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      contract.fileId = 'report-contract-source-derivation-mistyped-latest.json';
    },
  }),
  Object.freeze({
    scenarioId: 'script_id_drift',
    label: 'A package script id drifts away from the contract id',
    expectedBlockerCode: 'report_contract_source_derivation_script_id_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      contract.scriptId = 'reports:contract-source-derivation-mistyped';
    },
  }),
  Object.freeze({
    scenarioId: 'stdout_hash_field_drift',
    label: 'An exporter stdout hash field drifts away from the contract id',
    expectedBlockerCode: 'report_contract_source_derivation_stdout_hash_field_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      contract.stdoutHashField = 'contractSourceDerivationMistypedHash';
    },
  }),
  Object.freeze({
    scenarioId: 'gate_summary_hash_key_drift',
    label: 'A gate summary hash key drifts away from the contract id',
    expectedBlockerCode: 'report_contract_source_derivation_gate_summary_hash_key_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      contract.gateSummaryHashKey = 'reportContractSourceDerivationMistypedHash';
    },
  }),
  Object.freeze({
    scenarioId: 'primary_export_step_missing',
    label: 'A contract loses its canonical export step id',
    expectedBlockerCode: 'report_contract_source_derivation_primary_step_missing',
    mutate(input) {
      const contract = targetContract(input);
      contract.stepIds = ['report_contract_source_derivation_mistyped_export'];
    },
  }),
  Object.freeze({
    scenarioId: 'special_doc_override_missing',
    label: 'The shared freshness regression docs mapping is removed',
    expectedBlockerCode: 'report_contract_source_derivation_special_doc_override_missing',
    mutate(input) {
      delete input.docPathOverrides.report_freshness_regression;
    },
  }),
  Object.freeze({
    scenarioId: 'source_file_missing',
    label: 'A derived source module disappears',
    expectedBlockerCode: 'report_contract_source_derivation_source_file_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceFileIds = input.sourceFileIds.filter((fileId) => fileId !== expectedSourcePath(contract));
    },
  }),
  Object.freeze({
    scenarioId: 'docs_file_missing',
    label: 'A derived docs page disappears',
    expectedBlockerCode: 'report_contract_source_derivation_docs_file_missing',
    mutate(input) {
      const contract = input.manifest.find((item) => item.contractId === 'report_freshness_regression')
        || targetContract(input);
      input.docsFileIds = input.docsFileIds.filter((fileId) => fileId !== expectedDocsPath(contract));
    },
  }),
  Object.freeze({
    scenarioId: 'post_action_section_core_import_missing',
    label: 'A core-backed post-action section module loses the shared section core import',
    expectedBlockerCode: 'report_contract_source_derivation_section_core_import_missing',
    mutate(input) {
      const sourcePath = expectedSectionCoreSourcePath(POST_ACTION_SECTION_CORE_EXPECTATIONS[0]);
      input.sourceTextsByFileId[sourcePath] = String(input.sourceTextsByFileId[sourcePath] || '')
        .replace(SECTION_CORE_IMPORT_SNIPPET, "from './report-contract-doc-page-local-section-regression.mjs'");
    },
  }),
  Object.freeze({
    scenarioId: 'post_action_section_private_implementation_reintroduced',
    label: 'A core-backed post-action section module reintroduces private section analysis helpers',
    expectedBlockerCode: 'report_contract_source_derivation_section_core_private_implementation_present',
    mutate(input) {
      const sourcePath = expectedSectionCoreSourcePath(POST_ACTION_SECTION_CORE_EXPECTATIONS[1]);
      input.sourceTextsByFileId[sourcePath] = `${String(input.sourceTextsByFileId[sourcePath] || '')}\nfunction analyzeContract() { return null; }\n`;
    },
  }),
  Object.freeze({
    scenarioId: 'post_action_section_extra_safety_flag_missing',
    label: 'A core-backed dispatch-completion section module loses a required extra safety flag',
    expectedBlockerCode: 'report_contract_source_derivation_section_core_extra_safety_flag_missing',
    mutate(input) {
      const expectation = POST_ACTION_SECTION_CORE_EXPECTATIONS.find((item) => (
        item.contractId === 'report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression'
      ));
      const sourcePath = expectedSectionCoreSourcePath(expectation);
      input.sourceTextsByFileId[sourcePath] = String(input.sourceTextsByFileId[sourcePath] || '')
        .replace(/\n\s*runsDispatchCompletion:\s*false,/, '');
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function contractSlug(contract = {}) {
  return String(contract.contractId || '').replace(/_/g, '-');
}

function camelCaseSlug(slug = '') {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((part, index) => (index === 0
      ? part
      : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
    .join('');
}

function expectedScriptSlug(contract = {}) {
  return contractSlug(contract)
    .replace(/^report-/, '')
    .replace(/^integration-/, '');
}

function expectedStdoutHashSlug(contract = {}) {
  return contractSlug(contract)
    .replace(/^report-/, '')
    .replace(/^integration-gate-/, '');
}

function expectedFileId(contract = {}) {
  return `${contractSlug(contract)}-latest.json`;
}

function expectedMarkdownFileId(contract = {}) {
  return `${contractSlug(contract)}-latest.md`;
}

function expectedExporterPath(contract = {}) {
  return `src/export-${contractSlug(contract)}.mjs`;
}

function expectedSourcePath(contract = {}) {
  return `src/${contractSlug(contract)}.mjs`;
}

function expectedSectionCoreSourcePath(expectation = {}) {
  return `src/${contractSlug(expectation)}.mjs`;
}

function expectedDocsPath(contract = {}) {
  return REPORT_CONTRACT_SOURCE_DERIVATION_DOC_OVERRIDES[contract.contractId]
    || `docs/${contractSlug(contract)}.md`;
}

function expectedScriptId(contract = {}) {
  return `reports:${expectedScriptSlug(contract)}`;
}

function expectedStdoutHashField(contract = {}) {
  return `${camelCaseSlug(expectedStdoutHashSlug(contract))}Hash`;
}

function expectedGateSummaryHashKey(contract = {}) {
  return `${camelCaseSlug(contractSlug(contract))}Hash`;
}

function expectedPrimaryStepId(contract = {}) {
  return `${contract.contractId}_export`;
}

function expectedSourceSyntaxStepId(contract = {}) {
  return `syntax_${contract.contractId}`;
}

function expectedExporterSyntaxStepId(contract = {}) {
  return `syntax_${contract.contractId}_export`;
}

function expectedRequiredGateArgs(contract = {}) {
  return contract.contractId === 'report_freshness'
    ? ['--strict', '--skip-gate']
    : ['--strict'];
}

function expectedRequiresFreshnessInventory(contract = {}) {
  return contract.contractId !== 'report_freshness';
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    label: contract.label || null,
    scriptId: contract.scriptId || null,
    exporterPath: contract.exporterPath || null,
    stepIds: Array.isArray(contract.stepIds) ? [...contract.stepIds] : [],
    fileId: contract.fileId || null,
    stdoutHashField: contract.stdoutHashField || null,
    gateSummaryHashKey: contract.gateSummaryHashKey || null,
    requiredGateArgs: contract.requiredGateArgs ? [...contract.requiredGateArgs] : ['--strict'],
    requiresFreshnessInventory: contract.requiresFreshnessInventory !== false,
  };
}

function setEqual(left = [], right = []) {
  const leftValues = uniqueSorted(left);
  const rightValues = uniqueSorted(right);
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function analyzeContract(contract = {}, input = {}) {
  const sourceFileIds = new Set(input.sourceFileIds || []);
  const docsFileIds = new Set(input.docsFileIds || []);
  const expected = {
    slug: contractSlug(contract),
    fileId: expectedFileId(contract),
    markdownFileId: expectedMarkdownFileId(contract),
    exporterPath: expectedExporterPath(contract),
    sourcePath: expectedSourcePath(contract),
    docsPath: expectedDocsPath(contract),
    scriptId: expectedScriptId(contract),
    stdoutHashField: expectedStdoutHashField(contract),
    gateSummaryHashKey: expectedGateSummaryHashKey(contract),
    primaryStepId: expectedPrimaryStepId(contract),
    sourceSyntaxStepId: expectedSourceSyntaxStepId(contract),
    exporterSyntaxStepId: expectedExporterSyntaxStepId(contract),
    requiredGateArgs: expectedRequiredGateArgs(contract),
    requiresFreshnessInventory: expectedRequiresFreshnessInventory(contract),
  };
  const docOverrideExpected = Object.prototype.hasOwnProperty.call(
    REPORT_CONTRACT_SOURCE_DERIVATION_DOC_OVERRIDES,
    contract.contractId,
  );
  const actualDocOverride = input.docPathOverrides?.[contract.contractId] || null;
  const primaryStepPresent = contract.stepIds.includes(expected.primaryStepId);
  const requiredGateArgsMatch = setEqual(contract.requiredGateArgs || [], expected.requiredGateArgs);
  const freshnessInventoryMatch = contract.requiresFreshnessInventory === expected.requiresFreshnessInventory;
  const sourceFileExists = sourceFileIds.has(expected.sourcePath);
  const exporterFileExists = sourceFileIds.has(expected.exporterPath);
  const docsFileExists = docsFileIds.has(expected.docsPath);
  const blockers = [
    ...(contract.fileId === expected.fileId ? [] : [blocker(
      'report_contract_source_derivation_file_id_mismatch',
      `${contract.contractId} fileId must derive to ${expected.fileId}.`,
      { contractId: contract.contractId, expected: expected.fileId, actual: contract.fileId },
    )]),
    ...(contract.exporterPath === expected.exporterPath ? [] : [blocker(
      'report_contract_source_derivation_exporter_path_mismatch',
      `${contract.contractId} exporterPath must derive to ${expected.exporterPath}.`,
      { contractId: contract.contractId, expected: expected.exporterPath, actual: contract.exporterPath },
    )]),
    ...(contract.scriptId === expected.scriptId ? [] : [blocker(
      'report_contract_source_derivation_script_id_mismatch',
      `${contract.contractId} scriptId must derive to ${expected.scriptId}.`,
      { contractId: contract.contractId, expected: expected.scriptId, actual: contract.scriptId },
    )]),
    ...(contract.stdoutHashField === expected.stdoutHashField ? [] : [blocker(
      'report_contract_source_derivation_stdout_hash_field_mismatch',
      `${contract.contractId} stdoutHashField must derive to ${expected.stdoutHashField}.`,
      { contractId: contract.contractId, expected: expected.stdoutHashField, actual: contract.stdoutHashField },
    )]),
    ...(contract.gateSummaryHashKey === expected.gateSummaryHashKey ? [] : [blocker(
      'report_contract_source_derivation_gate_summary_hash_key_mismatch',
      `${contract.contractId} gateSummaryHashKey must derive to ${expected.gateSummaryHashKey}.`,
      { contractId: contract.contractId, expected: expected.gateSummaryHashKey, actual: contract.gateSummaryHashKey },
    )]),
    ...(primaryStepPresent ? [] : [blocker(
      'report_contract_source_derivation_primary_step_missing',
      `${contract.contractId} stepIds must include ${expected.primaryStepId}.`,
      { contractId: contract.contractId, expected: expected.primaryStepId, actual: contract.stepIds.join(',') },
    )]),
    ...(requiredGateArgsMatch ? [] : [blocker(
      'report_contract_source_derivation_required_gate_args_mismatch',
      `${contract.contractId} requiredGateArgs must derive to ${expected.requiredGateArgs.join(',')}.`,
      { contractId: contract.contractId, expected: expected.requiredGateArgs.join(','), actual: (contract.requiredGateArgs || []).join(',') },
    )]),
    ...(freshnessInventoryMatch ? [] : [blocker(
      'report_contract_source_derivation_freshness_inventory_flag_mismatch',
      `${contract.contractId} requiresFreshnessInventory must derive to ${expected.requiresFreshnessInventory}.`,
      { contractId: contract.contractId, expected: expected.requiresFreshnessInventory, actual: contract.requiresFreshnessInventory },
    )]),
    ...(docOverrideExpected && actualDocOverride !== expected.docsPath ? [blocker(
      'report_contract_source_derivation_special_doc_override_missing',
      `${contract.contractId} doc override must map to ${expected.docsPath}.`,
      { contractId: contract.contractId, expected: expected.docsPath, actual: actualDocOverride },
    )] : []),
    ...(sourceFileExists ? [] : [blocker(
      'report_contract_source_derivation_source_file_missing',
      `${contract.contractId} source module is missing at ${expected.sourcePath}.`,
      { contractId: contract.contractId, fileId: expected.sourcePath },
    )]),
    ...(exporterFileExists ? [] : [blocker(
      'report_contract_source_derivation_exporter_file_missing',
      `${contract.contractId} exporter module is missing at ${expected.exporterPath}.`,
      { contractId: contract.contractId, fileId: expected.exporterPath },
    )]),
    ...(docsFileExists ? [] : [blocker(
      'report_contract_source_derivation_docs_file_missing',
      `${contract.contractId} docs page is missing at ${expected.docsPath}.`,
      { contractId: contract.contractId, fileId: expected.docsPath },
    )]),
  ];
  return {
    contractId: contract.contractId,
    status: blockers.length ? 'blocked_report_contract_source_derivation_contract' : 'pass_report_contract_source_derivation_contract',
    ok: blockers.length === 0,
    expected,
    actual: {
      fileId: contract.fileId,
      markdownFileId: String(contract.fileId || '').replace(/\.json$/, '.md'),
      exporterPath: contract.exporterPath,
      sourcePath: expected.sourcePath,
      docsPath: actualDocOverride || `docs/${contractSlug(contract)}.md`,
      scriptId: contract.scriptId,
      stdoutHashField: contract.stdoutHashField,
      gateSummaryHashKey: contract.gateSummaryHashKey,
      stepIds: contract.stepIds,
      requiredGateArgs: contract.requiredGateArgs,
      requiresFreshnessInventory: contract.requiresFreshnessInventory,
    },
    matches: {
      fileId: contract.fileId === expected.fileId,
      markdownFileId: String(contract.fileId || '').replace(/\.json$/, '.md') === expected.markdownFileId,
      exporterPath: contract.exporterPath === expected.exporterPath,
      sourcePath: expected.sourcePath === expectedSourcePath(contract),
      docsPath: expected.docsPath === expectedDocsPath(contract),
      scriptId: contract.scriptId === expected.scriptId,
      stdoutHashField: contract.stdoutHashField === expected.stdoutHashField,
      gateSummaryHashKey: contract.gateSummaryHashKey === expected.gateSummaryHashKey,
      primaryStep: primaryStepPresent,
      sourceSyntaxStepId: expected.sourceSyntaxStepId === `syntax_${contract.contractId}`,
      exporterSyntaxStepId: expected.exporterSyntaxStepId === `syntax_${contract.contractId}_export`,
      requiredGateArgs: requiredGateArgsMatch,
      freshnessInventoryFlag: freshnessInventoryMatch,
      specialDocOverride: !docOverrideExpected || actualDocOverride === expected.docsPath,
    },
    files: {
      sourceFileExists,
      exporterFileExists,
      docsFileExists,
    },
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    expected: contract.expected,
    actual: contract.actual,
    matches: contract.matches,
    files: contract.files,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      expected: item.expected ?? null,
      actual: item.actual ?? null,
      fileId: item.fileId || null,
    })),
  };
}

function normalizeSourceTexts(sourceTextsByFileId = {}) {
  return Object.fromEntries(Object.entries(sourceTextsByFileId)
    .filter(([fileId]) => fileId)
    .map(([fileId, sourceText]) => [fileId, String(sourceText || '')]));
}

function includesFalseFlag(sourceText = '', flagId = '') {
  return new RegExp(`\\b${flagId}\\s*:\\s*false\\b`).test(sourceText);
}

function analyzeSectionCoreExpectation(expectation = {}, input = {}) {
  const manifestContract = (input.manifest || []).find((contract) => contract.contractId === expectation.contractId) || null;
  const sourcePath = expectedSectionCoreSourcePath(expectation);
  const sourceText = input.sourceTextsByFileId?.[sourcePath] || '';
  const sourceTextPresent = sourceText.length > 0;
  const helperUsages = SECTION_CORE_REQUIRED_HELPERS.map((helperId) => ({
    helperId,
    ok: sourceText.includes(helperId),
  }));
  const privateImplementationSnippets = SECTION_CORE_PRIVATE_IMPLEMENTATION_SNIPPETS.filter((snippet) => (
    sourceText.includes(snippet)
  ));
  const requiredExtraSafetyFlags = expectation.requiredExtraSafetyFlags || [];
  const extraSafetyFlags = requiredExtraSafetyFlags.map((flagId) => ({
    flagId,
    ok: includesFalseFlag(sourceText, flagId),
  }));
  const blockers = [
    ...(manifestContract ? [] : [blocker(
      'report_contract_source_derivation_section_core_contract_missing',
      `${expectation.contractId} must remain present while section core adoption is required.`,
      { contractId: expectation.contractId },
    )]),
    ...(sourceTextPresent ? [] : [blocker(
      'report_contract_source_derivation_section_core_source_text_missing',
      `${sourcePath} source text must be available for section core adoption analysis.`,
      { contractId: expectation.contractId, fileId: sourcePath },
    )]),
    ...(sourceText.includes(SECTION_CORE_IMPORT_SNIPPET) ? [] : [blocker(
      'report_contract_source_derivation_section_core_import_missing',
      `${sourcePath} must import ${SECTION_CORE_SOURCE_PATH}.`,
      { contractId: expectation.contractId, fileId: sourcePath, expected: SECTION_CORE_IMPORT_SNIPPET },
    )]),
    ...helperUsages.filter((helper) => !helper.ok).map((helper) => blocker(
      'report_contract_source_derivation_section_core_helper_missing',
      `${sourcePath} must delegate ${helper.helperId} to the shared section core.`,
      { contractId: expectation.contractId, fileId: sourcePath, expected: helper.helperId },
    )),
    ...privateImplementationSnippets.map((snippet) => blocker(
      'report_contract_source_derivation_section_core_private_implementation_present',
      `${sourcePath} must not reintroduce private section regression implementation helpers.`,
      { contractId: expectation.contractId, fileId: sourcePath, actual: snippet },
    )),
    ...extraSafetyFlags.filter((flag) => !flag.ok).map((flag) => blocker(
      'report_contract_source_derivation_section_core_extra_safety_flag_missing',
      `${sourcePath} must keep extraSafetyFlags.${flag.flagId}=false when delegating to the shared section core.`,
      { contractId: expectation.contractId, fileId: sourcePath, expected: `${flag.flagId}: false` },
    )),
  ];
  return {
    contractId: expectation.contractId,
    sourcePath,
    status: blockers.length ? 'blocked_report_contract_source_derivation_section_core_contract' : 'pass_report_contract_source_derivation_section_core_contract',
    ok: blockers.length === 0,
    sourceTextPresent,
    importsSectionCore: sourceText.includes(SECTION_CORE_IMPORT_SNIPPET),
    helperUsageCount: helperUsages.filter((helper) => helper.ok).length,
    requiredHelperUsageCount: SECTION_CORE_REQUIRED_HELPERS.length,
    privateImplementationSnippetCount: privateImplementationSnippets.length,
    extraSafetyFlagCount: extraSafetyFlags.filter((flag) => flag.ok).length,
    requiredExtraSafetyFlagCount: requiredExtraSafetyFlags.length,
    missingHelpers: helperUsages.filter((helper) => !helper.ok).map((helper) => helper.helperId),
    missingExtraSafetyFlags: extraSafetyFlags.filter((flag) => !flag.ok).map((flag) => flag.flagId),
    privateImplementationSnippets,
    blockers,
  };
}

function analyzeSectionCoreAdoption(input = {}) {
  const contracts = POST_ACTION_SECTION_CORE_EXPECTATIONS.map((expectation) => (
    analyzeSectionCoreExpectation(expectation, input)
  ));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_source_derivation_section_core_adoption' : 'pass_report_contract_source_derivation_section_core_adoption',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    importCount: contracts.filter((contract) => contract.importsSectionCore).length,
    helperUsageCount: contracts.reduce((sum, contract) => sum + contract.helperUsageCount, 0),
    requiredHelperUsageCount: contracts.reduce((sum, contract) => sum + contract.requiredHelperUsageCount, 0),
    privateImplementationFreeCount: contracts.filter((contract) => contract.privateImplementationSnippetCount === 0).length,
    extraSafetyFlagCount: contracts.reduce((sum, contract) => sum + contract.extraSafetyFlagCount, 0),
    requiredExtraSafetyFlagCount: contracts.reduce((sum, contract) => sum + contract.requiredExtraSafetyFlagCount, 0),
    contracts,
    blockers,
  };
}

function compactSectionCoreContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    sourcePath: contract.sourcePath || null,
    status: contract.status || null,
    ok: contract.ok === true,
    sourceTextPresent: contract.sourceTextPresent === true,
    importsSectionCore: contract.importsSectionCore === true,
    helperUsageCount: contract.helperUsageCount || 0,
    requiredHelperUsageCount: contract.requiredHelperUsageCount || 0,
    privateImplementationSnippetCount: contract.privateImplementationSnippetCount || 0,
    extraSafetyFlagCount: contract.extraSafetyFlagCount || 0,
    requiredExtraSafetyFlagCount: contract.requiredExtraSafetyFlagCount || 0,
    missingHelpers: contract.missingHelpers || [],
    missingExtraSafetyFlags: contract.missingExtraSafetyFlags || [],
    privateImplementationSnippets: contract.privateImplementationSnippets || [],
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      expected: item.expected ?? null,
      actual: item.actual ?? null,
    })),
  };
}

function compactSectionCoreAdoption(sectionCore = {}) {
  return {
    status: sectionCore.status || null,
    ok: sectionCore.ok === true,
    contractCount: sectionCore.contractCount || 0,
    okContractCount: sectionCore.okContractCount || 0,
    importCount: sectionCore.importCount || 0,
    helperUsageCount: sectionCore.helperUsageCount || 0,
    requiredHelperUsageCount: sectionCore.requiredHelperUsageCount || 0,
    privateImplementationFreeCount: sectionCore.privateImplementationFreeCount || 0,
    extraSafetyFlagCount: sectionCore.extraSafetyFlagCount || 0,
    requiredExtraSafetyFlagCount: sectionCore.requiredExtraSafetyFlagCount || 0,
    blockers: (sectionCore.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      fileId: item.fileId || null,
      expected: item.expected ?? null,
      actual: item.actual ?? null,
    })),
    contracts: (sectionCore.contracts || []).map(compactSectionCoreContract),
  };
}

function analyzeSourceDerivation(input = {}) {
  const contracts = (input.manifest || []).map((contract) => analyzeContract(contract, input));
  const specialDocOverrideIds = Object.keys(REPORT_CONTRACT_SOURCE_DERIVATION_DOC_OVERRIDES);
  const sectionCore = analyzeSectionCoreAdoption(input);
  const blockers = [
    ...contracts.flatMap((contract) => contract.blockers),
    ...sectionCore.blockers,
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_source_derivation_analysis' : 'pass_report_contract_source_derivation_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    fileIdMatchCount: contracts.filter((contract) => contract.matches.fileId).length,
    markdownFileIdMatchCount: contracts.filter((contract) => contract.matches.markdownFileId).length,
    exporterPathMatchCount: contracts.filter((contract) => contract.matches.exporterPath).length,
    sourcePathMatchCount: contracts.filter((contract) => contract.matches.sourcePath).length,
    docsPathMatchCount: contracts.filter((contract) => contract.matches.docsPath).length,
    scriptIdMatchCount: contracts.filter((contract) => contract.matches.scriptId).length,
    stdoutHashFieldMatchCount: contracts.filter((contract) => contract.matches.stdoutHashField).length,
    gateSummaryHashKeyMatchCount: contracts.filter((contract) => contract.matches.gateSummaryHashKey).length,
    primaryStepCount: contracts.filter((contract) => contract.matches.primaryStep).length,
    sourceSyntaxStepIdMatchCount: contracts.filter((contract) => contract.matches.sourceSyntaxStepId).length,
    exporterSyntaxStepIdMatchCount: contracts.filter((contract) => contract.matches.exporterSyntaxStepId).length,
    requiredGateArgsMatchCount: contracts.filter((contract) => contract.matches.requiredGateArgs).length,
    freshnessInventoryFlagMatchCount: contracts.filter((contract) => contract.matches.freshnessInventoryFlag).length,
    specialDocOverrideCount: specialDocOverrideIds.length,
    specialDocOverridePresentCount: specialDocOverrideIds.filter((contractId) => (
      input.docPathOverrides?.[contractId] === REPORT_CONTRACT_SOURCE_DERIVATION_DOC_OVERRIDES[contractId]
    )).length,
    sourceFileCount: contracts.filter((contract) => contract.files.sourceFileExists).length,
    exporterFileCount: contracts.filter((contract) => contract.files.exporterFileExists).length,
    docsFileCount: contracts.filter((contract) => contract.files.docsFileExists).length,
    sectionCore,
    contracts,
    blockers,
  };
}

function compactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    contractCount: analysis.contractCount || 0,
    okContractCount: analysis.okContractCount || 0,
    fileIdMatchCount: analysis.fileIdMatchCount || 0,
    markdownFileIdMatchCount: analysis.markdownFileIdMatchCount || 0,
    exporterPathMatchCount: analysis.exporterPathMatchCount || 0,
    sourcePathMatchCount: analysis.sourcePathMatchCount || 0,
    docsPathMatchCount: analysis.docsPathMatchCount || 0,
    scriptIdMatchCount: analysis.scriptIdMatchCount || 0,
    stdoutHashFieldMatchCount: analysis.stdoutHashFieldMatchCount || 0,
    gateSummaryHashKeyMatchCount: analysis.gateSummaryHashKeyMatchCount || 0,
    primaryStepCount: analysis.primaryStepCount || 0,
    sourceSyntaxStepIdMatchCount: analysis.sourceSyntaxStepIdMatchCount || 0,
    exporterSyntaxStepIdMatchCount: analysis.exporterSyntaxStepIdMatchCount || 0,
    requiredGateArgsMatchCount: analysis.requiredGateArgsMatchCount || 0,
    freshnessInventoryFlagMatchCount: analysis.freshnessInventoryFlagMatchCount || 0,
    specialDocOverrideCount: analysis.specialDocOverrideCount || 0,
    specialDocOverridePresentCount: analysis.specialDocOverridePresentCount || 0,
    sourceFileCount: analysis.sourceFileCount || 0,
    exporterFileCount: analysis.exporterFileCount || 0,
    docsFileCount: analysis.docsFileCount || 0,
    sectionCore: compactSectionCoreAdoption(analysis.sectionCore),
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      expected: item.expected ?? null,
      actual: item.actual ?? null,
      fileId: item.fileId || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeSourceDerivation(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_source_derivation_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract source derivation analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_source_derivation_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_source_derivation_scenario' : 'pass_report_contract_source_derivation_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractSourceDerivationRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  sourceFileIds = [],
  docsFileIds = [],
  sourceTextsByFileId = {},
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    docPathOverrides: { ...docPathOverrides },
    sourceFileIds: [...sourceFileIds],
    docsFileIds: [...docsFileIds],
    sourceTextsByFileId: normalizeSourceTexts(sourceTextsByFileId),
  };
}

export function buildReportContractSourceDerivationRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  sourceFileIds = [],
  docsFileIds = [],
  sourceTextsByFileId = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractSourceDerivationRegressionInput({
    manifest,
    docPathOverrides,
    sourceFileIds,
    docsFileIds,
    sourceTextsByFileId,
  });
  const actual = analyzeSourceDerivation(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_source_derivation',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_VERSION,
    kind: 'ReportContractSourceDerivationRegression',
    status: blockers.length ? 'blocked_report_contract_source_derivation_regression' : 'pass_report_contract_source_derivation_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docOverrides: { ...REPORT_CONTRACT_SOURCE_DERIVATION_DOC_OVERRIDES },
      sectionCoreSourcePath: SECTION_CORE_SOURCE_PATH,
      sectionCoreContractIds: POST_ACTION_SECTION_CORE_EXPECTATIONS.map((expectation) => expectation.contractId),
      scriptPrefixRules: ['drop report-', 'drop integration-'],
      stdoutHashPrefixRules: ['drop report-', 'drop integration-gate-'],
    },
    actual: {
      ...compactAnalysis(actual),
      contracts: actual.contracts.map(compactContract),
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      contractCount: actual.contractCount,
      okContractCount: actual.okContractCount,
      fileIdMatchCount: actual.fileIdMatchCount,
      markdownFileIdMatchCount: actual.markdownFileIdMatchCount,
      exporterPathMatchCount: actual.exporterPathMatchCount,
      sourcePathMatchCount: actual.sourcePathMatchCount,
      docsPathMatchCount: actual.docsPathMatchCount,
      scriptIdMatchCount: actual.scriptIdMatchCount,
      stdoutHashFieldMatchCount: actual.stdoutHashFieldMatchCount,
      gateSummaryHashKeyMatchCount: actual.gateSummaryHashKeyMatchCount,
      primaryStepCount: actual.primaryStepCount,
      sourceSyntaxStepIdMatchCount: actual.sourceSyntaxStepIdMatchCount,
      exporterSyntaxStepIdMatchCount: actual.exporterSyntaxStepIdMatchCount,
      requiredGateArgsMatchCount: actual.requiredGateArgsMatchCount,
      freshnessInventoryFlagMatchCount: actual.freshnessInventoryFlagMatchCount,
      specialDocOverrideCount: actual.specialDocOverrideCount,
      specialDocOverridePresentCount: actual.specialDocOverridePresentCount,
      sourceFileCount: actual.sourceFileCount,
      exporterFileCount: actual.exporterFileCount,
      docsFileCount: actual.docsFileCount,
      sectionCoreActualOk: actual.sectionCore.ok === true,
      sectionCoreContractCount: actual.sectionCore.contractCount,
      sectionCoreOkContractCount: actual.sectionCore.okContractCount,
      sectionCoreImportCount: actual.sectionCore.importCount,
      sectionCoreHelperUsageCount: actual.sectionCore.helperUsageCount,
      sectionCoreRequiredHelperUsageCount: actual.sectionCore.requiredHelperUsageCount,
      sectionCorePrivateImplementationFreeCount: actual.sectionCore.privateImplementationFreeCount,
      sectionCoreExtraSafetyFlagCount: actual.sectionCore.extraSafetyFlagCount,
      sectionCoreRequiredExtraSafetyFlagCount: actual.sectionCore.requiredExtraSafetyFlagCount,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      observedExpectedBlockerCount: scenarios.filter((scenario) => (
        scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
      )).length,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      sourceInspectionOnly: true,
      mutatesReportFiles: false,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const contractSourceDerivationRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    fixture: report.fixture,
    actual: report.actual,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
      analysis: scenario.analysis,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    contractSourceDerivationRegressionHash,
    hash: contractSourceDerivationRegressionHash,
  };
}

export function summarizeReportContractSourceDerivationRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_contract_source_derivation_regression',
    ok: report?.ok === true,
    contractSourceDerivationRegressionHash: report?.contractSourceDerivationRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    okContractCount: report?.summary?.okContractCount || 0,
    fileIdMatchCount: report?.summary?.fileIdMatchCount || 0,
    markdownFileIdMatchCount: report?.summary?.markdownFileIdMatchCount || 0,
    exporterPathMatchCount: report?.summary?.exporterPathMatchCount || 0,
    sourcePathMatchCount: report?.summary?.sourcePathMatchCount || 0,
    docsPathMatchCount: report?.summary?.docsPathMatchCount || 0,
    scriptIdMatchCount: report?.summary?.scriptIdMatchCount || 0,
    stdoutHashFieldMatchCount: report?.summary?.stdoutHashFieldMatchCount || 0,
    gateSummaryHashKeyMatchCount: report?.summary?.gateSummaryHashKeyMatchCount || 0,
    primaryStepCount: report?.summary?.primaryStepCount || 0,
    sourceSyntaxStepIdMatchCount: report?.summary?.sourceSyntaxStepIdMatchCount || 0,
    exporterSyntaxStepIdMatchCount: report?.summary?.exporterSyntaxStepIdMatchCount || 0,
    requiredGateArgsMatchCount: report?.summary?.requiredGateArgsMatchCount || 0,
    freshnessInventoryFlagMatchCount: report?.summary?.freshnessInventoryFlagMatchCount || 0,
    specialDocOverrideCount: report?.summary?.specialDocOverrideCount || 0,
    specialDocOverridePresentCount: report?.summary?.specialDocOverridePresentCount || 0,
    sourceFileCount: report?.summary?.sourceFileCount || 0,
    exporterFileCount: report?.summary?.exporterFileCount || 0,
    docsFileCount: report?.summary?.docsFileCount || 0,
    sectionCoreActualOk: report?.summary?.sectionCoreActualOk === true,
    sectionCoreContractCount: report?.summary?.sectionCoreContractCount || 0,
    sectionCoreOkContractCount: report?.summary?.sectionCoreOkContractCount || 0,
    sectionCoreImportCount: report?.summary?.sectionCoreImportCount || 0,
    sectionCoreHelperUsageCount: report?.summary?.sectionCoreHelperUsageCount || 0,
    sectionCoreRequiredHelperUsageCount: report?.summary?.sectionCoreRequiredHelperUsageCount || 0,
    sectionCorePrivateImplementationFreeCount: report?.summary?.sectionCorePrivateImplementationFreeCount || 0,
    sectionCoreExtraSafetyFlagCount: report?.summary?.sectionCoreExtraSafetyFlagCount || 0,
    sectionCoreRequiredExtraSafetyFlagCount: report?.summary?.sectionCoreRequiredExtraSafetyFlagCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      sourceInspectionOnly: report?.safety?.sourceInspectionOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
