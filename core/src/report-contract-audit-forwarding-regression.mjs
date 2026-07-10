import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_REPORT_FILE_ID = 'report-contract-audit-forwarding-regression-latest.json';
export const REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_SCRIPT_ID = 'reports:contract-audit-forwarding-regression';
export const REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_STEP_ID = 'report_contract_audit_forwarding_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_doc_coverage_regression';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_audit_forwarding',
    label: 'A new manifest contract is added without audit blocker forwarding',
    expectedBlockerCode: 'report_contract_audit_forwarding_loop_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_audit_forwarding',
        label: 'Report future audit forwarding',
        scriptId: 'reports:future-audit-forwarding',
        exporterPath: 'src/export-report-future-audit-forwarding.mjs',
        stepIds: ['report_future_audit_forwarding_export'],
        fileId: 'report-future-audit-forwarding-latest.json',
        stdoutHashField: 'futureAuditForwardingHash',
        gateSummaryHashKey: 'reportFutureAuditForwardingHash',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'build_blockers_parameter_missing',
    label: 'buildBlockers stops destructuring a contract report object',
    expectedBlockerCode: 'report_contract_audit_forwarding_parameter_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = replaceToken(
        input.auditSourceText,
        `  ${summaryBaseKey(contract)},\n`,
        '',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'build_blockers_call_binding_missing',
    label: 'The audit builder stops passing a contract report into buildBlockers',
    expectedBlockerCode: 'report_contract_audit_forwarding_call_binding_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = replaceFirstBuildBlockersCallBinding(
        input.auditSourceText,
        summaryBaseKey(contract),
      );
    },
  }),
  Object.freeze({
    scenarioId: 'forwarding_loop_missing',
    label: 'The audit blocker forwarding loop is removed for one contract',
    expectedBlockerCode: 'report_contract_audit_forwarding_loop_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = mutateForwardingBlock(input.auditSourceText, contract, (block) => (
        block.replace(`${summaryBaseKey(contract)}?.blockers`, 'missingContractReport?.blockers')
      ));
    },
  }),
  Object.freeze({
    scenarioId: 'forwarding_prefix_drift',
    label: 'The audit blocker forwarding prefix drifts away from the contract id',
    expectedBlockerCode: 'report_contract_audit_forwarding_prefix_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = mutateForwardingBlock(input.auditSourceText, contract, (block, blockerVar) => (
        block.replace(
          expectedForwardedCodeExpression(contract, blockerVar),
          '`report_contract_doc_coverage_mistyped_${contractDocCoverageRegressionBlocker.code}`',
        )
      ));
    },
  }),
  Object.freeze({
    scenarioId: 'forwarding_child_code_missing',
    label: 'The audit blocker forwarding code stops using the child blocker code',
    expectedBlockerCode: 'report_contract_audit_forwarding_child_code_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = mutateForwardingBlock(input.auditSourceText, contract, (block, blockerVar) => (
        block.replace(`\${${blockerVar}.code}`, `\${${blockerVar}.status}`)
      ));
    },
  }),
  Object.freeze({
    scenarioId: 'forwarding_notes_missing',
    label: 'The audit blocker forwarding notes stop using child blocker notes',
    expectedBlockerCode: 'report_contract_audit_forwarding_notes_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = mutateForwardingBlock(input.auditSourceText, contract, (block, blockerVar) => (
        block.replace(`${blockerVar}.notes`, '\'missing notes\'')
      ));
    },
  }),
  Object.freeze({
    scenarioId: 'forwarding_owner_missing',
    label: 'The audit blocker forwarding owner drifts away from design-production-core',
    expectedBlockerCode: 'report_contract_audit_forwarding_owner_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.auditSourceText = mutateForwardingBlock(input.auditSourceText, contract, (block) => (
        block.replace('\'design-production-core\'', '\'wrong-owner\'')
      ));
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceToken(sourceText, token, replacement) {
  return String(sourceText || '').split(token).join(replacement);
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    stdoutHashField: contract.stdoutHashField || null,
    gateSummaryHashKey: contract.gateSummaryHashKey || null,
  };
}

function summaryBaseKey(contract = {}) {
  return String(contract.gateSummaryHashKey || '').replace(/Hash$/, '');
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function expectedForwardedCodeExpression(contract = {}, blockerVar = '') {
  return `\`${contract.contractId}_\${${blockerVar}.code}\``;
}

function extractFunctionObjectBlock(sourceText = '', functionName = '') {
  const pattern = new RegExp(`function\\s+${escapeRegExp(functionName)}\\s*\\(\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*\\)\\s*\\{`);
  return String(sourceText || '').match(pattern)?.[1] || '';
}

function extractBuildBlockersCallBlock(sourceText = '') {
  return String(sourceText || '').match(/const\s+blockers\s*=\s*buildBlockers\(\{\s*([\s\S]*?)\n\s*\}\);/)?.[1] || '';
}

function identifierListed(sourceText = '', key = '') {
  return new RegExp(`\\b${escapeRegExp(key)}\\s*,`).test(String(sourceText || ''));
}

function extractForwardingBlock(sourceText = '', contract = {}) {
  const reportKey = summaryBaseKey(contract);
  const pattern = new RegExp(
    `for\\s*\\(\\s*const\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${escapeRegExp(reportKey)}\\?\\.blockers\\s*\\|\\|\\s*\\[\\]\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
  );
  const match = String(sourceText || '').match(pattern);
  if (!match) {
    return {
      found: false,
      blockerVar: null,
      block: '',
    };
  }
  return {
    found: true,
    blockerVar: match[1],
    block: match[0],
    body: match[2],
  };
}

function mutateForwardingBlock(sourceText = '', contract = {}, mutate) {
  const forwarding = extractForwardingBlock(sourceText, contract);
  if (!forwarding.found) return sourceText;
  return String(sourceText || '').replace(
    forwarding.block,
    mutate(forwarding.block, forwarding.blockerVar),
  );
}

function replaceFirstBuildBlockersCallBinding(sourceText = '', key = '') {
  const callBlock = extractBuildBlockersCallBlock(sourceText);
  if (!callBlock) return sourceText;
  const replacementBlock = callBlock.replace(new RegExp(`\\n\\s*${escapeRegExp(key)},`), '');
  return String(sourceText || '').replace(callBlock, replacementBlock);
}

function analyzeContract(contract = {}, input = {}) {
  const reportKey = summaryBaseKey(contract);
  const parameterBlock = extractFunctionObjectBlock(input.auditSourceText, 'buildBlockers');
  const callBlock = extractBuildBlockersCallBlock(input.auditSourceText);
  const forwarding = extractForwardingBlock(input.auditSourceText, contract);
  const forwardingBody = forwarding.body || '';
  const expectedCodeExpression = forwarding.blockerVar
    ? expectedForwardedCodeExpression(contract, forwarding.blockerVar)
    : null;
  const parameterPresent = identifierListed(parameterBlock, reportKey);
  const callBindingPresent = identifierListed(callBlock, reportKey);
  const forwardingLoopPresent = forwarding.found === true;
  const blockerPushPresent = forwardingLoopPresent && /blockers\.push\(\s*blocker\(/.test(forwardingBody);
  const prefixPresent = forwardingLoopPresent && forwardingBody.includes(expectedCodeExpression);
  const childCodePresent = forwardingLoopPresent && forwardingBody.includes(`\${${forwarding.blockerVar}.code}`);
  const notesPresent = forwardingLoopPresent && forwardingBody.includes(`${forwarding.blockerVar}.notes`);
  const ownerPresent = forwardingLoopPresent && (
    forwardingBody.includes('\'design-production-core\'')
    || forwardingBody.includes('"design-production-core"')
  );
  const blockers = [
    ...(parameterPresent ? [] : [blocker(
      'report_contract_audit_forwarding_parameter_missing',
      `${contract.contractId} must be destructured into buildBlockers as ${reportKey}.`,
      { contractId: contract.contractId, key: reportKey },
    )]),
    ...(callBindingPresent ? [] : [blocker(
      'report_contract_audit_forwarding_call_binding_missing',
      `${contract.contractId} must be passed into buildBlockers as ${reportKey}.`,
      { contractId: contract.contractId, key: reportKey },
    )]),
    ...(forwardingLoopPresent ? [] : [blocker(
      'report_contract_audit_forwarding_loop_missing',
      `${contract.contractId} blockers must be forwarded from ${reportKey}.blockers.`,
      { contractId: contract.contractId, key: reportKey },
    )]),
    ...(blockerPushPresent ? [] : [blocker(
      'report_contract_audit_forwarding_push_missing',
      `${contract.contractId} forwarding loop must push an audit blocker.`,
      { contractId: contract.contractId, key: reportKey },
    )]),
    ...(prefixPresent ? [] : [blocker(
      'report_contract_audit_forwarding_prefix_mismatch',
      `${contract.contractId} forwarded blocker code must use ${expectedCodeExpression || `${contract.contractId}_\${child.code}`}.`,
      { contractId: contract.contractId, key: contract.contractId },
    )]),
    ...(childCodePresent ? [] : [blocker(
      'report_contract_audit_forwarding_child_code_missing',
      `${contract.contractId} forwarded blocker code must include the child blocker .code field.`,
      { contractId: contract.contractId, key: 'code' },
    )]),
    ...(notesPresent ? [] : [blocker(
      'report_contract_audit_forwarding_notes_missing',
      `${contract.contractId} forwarded blocker notes must preserve the child blocker .notes field.`,
      { contractId: contract.contractId, key: 'notes' },
    )]),
    ...(ownerPresent ? [] : [blocker(
      'report_contract_audit_forwarding_owner_missing',
      `${contract.contractId} forwarded blockers must stay owned by design-production-core.`,
      { contractId: contract.contractId, key: 'design-production-core' },
    )]),
  ];
  return {
    contractId: contract.contractId,
    status: blockers.length ? 'blocked_report_contract_audit_forwarding_contract' : 'pass_report_contract_audit_forwarding_contract',
    ok: blockers.length === 0,
    reportKey,
    forwardedCodePrefix: contract.contractId,
    blockerVariable: forwarding.blockerVar,
    parameterPresent,
    callBindingPresent,
    forwardingLoopPresent,
    blockerPushPresent,
    prefixPresent,
    childCodePresent,
    notesPresent,
    ownerPresent,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    reportKey: contract.reportKey,
    forwardedCodePrefix: contract.forwardedCodePrefix,
    blockerVariable: contract.blockerVariable,
    parameterPresent: contract.parameterPresent === true,
    callBindingPresent: contract.callBindingPresent === true,
    forwardingLoopPresent: contract.forwardingLoopPresent === true,
    blockerPushPresent: contract.blockerPushPresent === true,
    prefixPresent: contract.prefixPresent === true,
    childCodePresent: contract.childCodePresent === true,
    notesPresent: contract.notesPresent === true,
    ownerPresent: contract.ownerPresent === true,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      key: item.key || null,
    })),
  };
}

function analyzeAuditForwarding(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const blockers = contractAnalyses.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_audit_forwarding_analysis' : 'pass_report_contract_audit_forwarding_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    parameterCount: contractAnalyses.filter((contract) => contract.parameterPresent).length,
    callBindingCount: contractAnalyses.filter((contract) => contract.callBindingPresent).length,
    forwardingLoopCount: contractAnalyses.filter((contract) => contract.forwardingLoopPresent).length,
    blockerPushCount: contractAnalyses.filter((contract) => contract.blockerPushPresent).length,
    prefixCount: contractAnalyses.filter((contract) => contract.prefixPresent).length,
    childCodeCount: contractAnalyses.filter((contract) => contract.childCodePresent).length,
    notesCount: contractAnalyses.filter((contract) => contract.notesPresent).length,
    ownerCount: contractAnalyses.filter((contract) => contract.ownerPresent).length,
    contracts: contractAnalyses,
    blockers,
  };
}

function compactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    contractCount: analysis.contractCount || 0,
    okContractCount: analysis.okContractCount || 0,
    parameterCount: analysis.parameterCount || 0,
    callBindingCount: analysis.callBindingCount || 0,
    forwardingLoopCount: analysis.forwardingLoopCount || 0,
    blockerPushCount: analysis.blockerPushCount || 0,
    prefixCount: analysis.prefixCount || 0,
    childCodeCount: analysis.childCodeCount || 0,
    notesCount: analysis.notesCount || 0,
    ownerCount: analysis.ownerCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      key: item.key || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeAuditForwarding(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_audit_forwarding_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract audit forwarding analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_audit_forwarding_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_audit_forwarding_scenario' : 'pass_report_contract_audit_forwarding_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractAuditForwardingRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  auditSourceText = '',
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    auditSourceText: String(auditSourceText || ''),
  };
}

export function buildReportContractAuditForwardingRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  auditSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractAuditForwardingRegressionInput({
    manifest,
    auditSourceText,
  });
  const actual = analyzeAuditForwarding(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_audit_forwarding',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_VERSION,
    kind: 'ReportContractAuditForwardingRegression',
    status: blockers.length ? 'blocked_report_contract_audit_forwarding_regression' : 'pass_report_contract_audit_forwarding_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
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
      parameterCount: actual.parameterCount,
      callBindingCount: actual.callBindingCount,
      forwardingLoopCount: actual.forwardingLoopCount,
      blockerPushCount: actual.blockerPushCount,
      prefixCount: actual.prefixCount,
      childCodeCount: actual.childCodeCount,
      notesCount: actual.notesCount,
      ownerCount: actual.ownerCount,
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
  const contractAuditForwardingRegressionHash = digest({
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
    contractAuditForwardingRegressionHash,
    hash: contractAuditForwardingRegressionHash,
  };
}

export function summarizeReportContractAuditForwardingRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_contract_audit_forwarding_regression',
    ok: report?.ok === true,
    contractAuditForwardingRegressionHash: report?.contractAuditForwardingRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    okContractCount: report?.summary?.okContractCount || 0,
    parameterCount: report?.summary?.parameterCount || 0,
    callBindingCount: report?.summary?.callBindingCount || 0,
    forwardingLoopCount: report?.summary?.forwardingLoopCount || 0,
    blockerPushCount: report?.summary?.blockerPushCount || 0,
    prefixCount: report?.summary?.prefixCount || 0,
    childCodeCount: report?.summary?.childCodeCount || 0,
    notesCount: report?.summary?.notesCount || 0,
    ownerCount: report?.summary?.ownerCount || 0,
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
