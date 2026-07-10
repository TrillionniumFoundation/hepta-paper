import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_SECTION_REGRESSION_CORE_VERSION = 1;

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    label: contract.label || null,
    scriptId: contract.scriptId || null,
    fileId: contract.fileId || null,
  };
}

function docsPathFor(contract = {}, overrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES) {
  if (overrides?.[contract.contractId]) return overrides[contract.contractId];
  return `docs/${String(contract.fileId || '').replace(/-latest\.json$/, '.md')}`;
}

function targetContract(input = {}, targetContractId = 'report_contract_manifest') {
  return input.manifest.find((contract) => contract.contractId === targetContractId)
    || input.manifest[0];
}

function presenceKey(bindingKey = '') {
  return `${bindingKey}Present`;
}

function countPresent(contracts = [], bindingKey = '') {
  return contracts.filter((contract) => contract[presenceKey(bindingKey)]).length;
}

function sentenceBindings(config = {}) {
  return Array.isArray(config.sentenceBindings) ? config.sentenceBindings : [];
}

function sectionSlug(config = {}) {
  return config.statusSlug || 'report_contract_doc_page_section';
}

function requiredConfig(config = {}) {
  const missing = [
    'version',
    'kind',
    'reportFileId',
    'scriptId',
    'headingPrefix',
    'sectionKindLabel',
    'statusSlug',
    'hashField',
  ].filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`report contract doc page section regression config missing: ${missing.join(', ')}`);
  }
  return config;
}

function bindingByKey(config = {}, key = '') {
  return sentenceBindings(config).find((binding) => binding.key === key);
}

function orderedSentenceBlock(config = {}, keys = sentenceBindings(config).map((binding) => binding.key)) {
  return keys.map((key) => bindingByKey(config, key)?.sentence || '').join('\n\n');
}

export function buildSentenceSectionHeading({
  headingPrefix = '',
  contractId = '',
} = {}) {
  return `${headingPrefix}${contractId}`;
}

export function buildSentenceSectionMarkdownBlock({
  headingPrefix = '',
  sentenceBindings: bindings = [],
  contract = {},
} = {}) {
  return [
    buildSentenceSectionHeading({ headingPrefix, contractId: contract.contractId }),
    '',
    ...bindings.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

export function extractSentenceSection({
  text = '',
  headingPrefix = '',
  contractId = '',
} = {}) {
  const heading = buildSentenceSectionHeading({ headingPrefix, contractId });
  const source = String(text || '');
  const lineStartNeedle = `\n${heading}\n`;
  const embeddedStart = source.indexOf(lineStartNeedle);
  const start = source.startsWith(`${heading}\n`)
    ? 0
    : (embeddedStart < 0 ? -1 : embeddedStart + 1);
  if (start < 0) return null;
  const nextHeading = source.indexOf('\n## ', start + heading.length);
  return source.slice(start, nextHeading < 0 ? undefined : nextHeading).trimEnd();
}

export function replaceSentenceSection({
  text = '',
  headingPrefix = '',
  contractId = '',
  replacer = (section) => section,
} = {}) {
  const heading = buildSentenceSectionHeading({ headingPrefix, contractId });
  const source = String(text || '');
  const lineStartNeedle = `\n${heading}\n`;
  const embeddedStart = source.indexOf(lineStartNeedle);
  const start = source.startsWith(`${heading}\n`)
    ? 0
    : (embeddedStart < 0 ? -1 : embeddedStart + 1);
  if (start < 0) return source;
  const nextHeading = source.indexOf('\n## ', start + heading.length);
  const end = nextHeading < 0 ? source.length : nextHeading;
  return `${source.slice(0, start)}${replacer(source.slice(start, end), contractId)}${source.slice(end)}`;
}

function mutateTargetDocsSection(config = {}, input = {}, sectionMutator = (section) => section) {
  const contract = targetContract(input, config.targetContractId || 'report_contract_manifest');
  const docsPath = docsPathFor(contract, input.docPathOverrides);
  input.docsByPath[docsPath] = replaceSentenceSection({
    text: input.docsByPath[docsPath] || '',
    headingPrefix: config.headingPrefix,
    contractId: contract.contractId,
    replacer: (section) => sectionMutator(section, contract),
  });
}

export function buildSentenceSectionRegressionScenarios(config = {}) {
  requiredConfig(config);
  const missing = config.missingSectionScenario || {};
  const futureContract = missing.futureContract || {
    contractId: `report_future_${sectionSlug(config)}`,
    label: `Report future ${config.sectionKindLabel}`,
    scriptId: `reports:future-${sectionSlug(config).replaceAll('_', '-')}`,
    fileId: `report-future-${sectionSlug(config).replaceAll('_', '-')}-latest.json`,
  };
  const scenarios = [
    Object.freeze({
      scenarioId: missing.scenarioId || `new_manifest_contract_without_${sectionSlug(config)}`,
      label: missing.label || `A new manifest contract is added with docs but without a ${config.sectionKindLabel}`,
      expectedBlockerCode: missing.expectedBlockerCode || `${sectionSlug(config)}_missing`,
      mutate(input) {
        input.manifest.push(futureContract);
        input.docsByPath[docsPathFor(futureContract, input.docPathOverrides)] = missing.docsText || `# ${futureContract.label}\n`;
      },
    }),
    ...sentenceBindings(config).map((binding) => Object.freeze({
      scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
      label: `A contract ${config.sectionKindLabel} loses its ${binding.label} binding sentence`,
      expectedBlockerCode: binding.blockerCode,
      mutate(input) {
        mutateTargetDocsSection(config, input, (section) => section.replace(binding.sentence, ''));
      },
    })),
  ];
  if (config.orderScenario) {
    const orderKeys = sentenceBindings(config).map((binding) => binding.key);
    scenarios.push(Object.freeze({
      scenarioId: config.orderScenario.scenarioId || `${sectionSlug(config)}_order_drift`,
      label: config.orderScenario.label || `A contract ${config.sectionKindLabel} changes sentence order`,
      expectedBlockerCode: config.orderScenario.expectedBlockerCode || `${sectionSlug(config)}_order_invalid`,
      mutate(input) {
        mutateTargetDocsSection(config, input, (section) => section.replace(
          orderedSentenceBlock(config, config.orderScenario.originalBindingKeys || orderKeys),
          orderedSentenceBlock(config, config.orderScenario.reorderedBindingKeys || [...orderKeys].reverse()),
        ));
      },
    }));
  }
  if (config.sharedDocPathOverrideScenario !== false) {
    const shared = config.sharedDocPathOverrideScenario || {};
    scenarios.push(Object.freeze({
      scenarioId: shared.scenarioId || 'shared_doc_path_override_missing',
      label: shared.label || 'A shared docs page loses its explicit manifest-to-doc mapping',
      expectedBlockerCode: shared.expectedBlockerCode || `${sectionSlug(config)}_docs_missing`,
      mutate(input) {
        const docPathOverrides = { ...input.docPathOverrides };
        delete docPathOverrides[shared.overrideContractId || 'report_freshness_regression'];
        input.docPathOverrides = docPathOverrides;
      },
    }));
  }
  return Object.freeze(scenarios);
}

function expectedPartsFor(config = {}, contract = {}) {
  return [
    {
      key: 'sectionHeading',
      part: buildSentenceSectionHeading({
        headingPrefix: config.headingPrefix,
        contractId: contract.contractId,
      }),
    },
    ...sentenceBindings(config).map((binding) => ({
      key: binding.key,
      part: binding.sentence,
    })),
  ];
}

function analyzeContract(config = {}, contract = {}, input = {}) {
  const docsPath = docsPathFor(contract, input.docPathOverrides);
  const docsExists = Object.hasOwn(input.docsByPath || {}, docsPath);
  const docsText = docsExists ? String(input.docsByPath[docsPath] || '') : '';
  const sectionText = docsExists
    ? extractSentenceSection({
      text: docsText,
      headingPrefix: config.headingPrefix,
      contractId: contract.contractId,
    })
    : null;
  const expectedParts = expectedPartsFor(config, contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : String(sectionText || '').indexOf(entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    sentenceBindings(config).map((binding) => [
      presenceKey(binding.key),
      positions[binding.key] >= 0,
    ]),
  );
  const orderValues = expectedParts.map((entry) => positions[entry.key]);
  const orderValid = sectionText != null
    && orderValues.every((position) => position >= 0)
    && orderValues.every((position, index, values) => index === 0 || values[index - 1] < position);
  const slug = sectionSlug(config);
  const heading = buildSentenceSectionHeading({
    headingPrefix: config.headingPrefix,
    contractId: contract.contractId,
  });
  const blockers = [
    ...(docsExists ? [] : [blocker(
      `${slug}_docs_missing`,
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      `${slug}_missing`,
      `${docsPath} must include ${heading}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...sentenceBindings(config).flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} ${config.sectionKindLabel} must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      `${slug}_order_invalid`,
      config.orderInvalidNotes || `${docsPath} ${config.sectionKindLabel} must preserve canonical heading and binding sentence order.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? `blocked_${slug}_contract` : `pass_${slug}_contract`,
    ok: blockers.length === 0,
    docsExists,
    sectionPresent: sectionText != null,
    ...bindingPresence,
    orderValid,
    positions,
    blockerCount: blockers.length,
    blockers,
  };
}

function compactContract(config = {}, contract = {}) {
  return {
    contractId: contract.contractId,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath: contract.docsPath,
    status: contract.status,
    ok: contract.ok === true,
    docsExists: contract.docsExists === true,
    sectionPresent: contract.sectionPresent === true,
    ...Object.fromEntries(sentenceBindings(config).map((binding) => [
      presenceKey(binding.key),
      contract[presenceKey(binding.key)] === true,
    ])),
    orderValid: contract.orderValid === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
    })),
  };
}

function analyzeSentenceSections(config = {}, input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(config, contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  const slug = sectionSlug(config);
  return {
    status: blockers.length ? `blocked_${slug}_analysis` : `pass_${slug}_analysis`,
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(sentenceBindings(config).map((binding) => [
      `${binding.key}Count`,
      countPresent(contracts, binding.key),
    ])),
    orderCount: contracts.filter((contract) => contract.orderValid).length,
    contracts,
    blockers,
  };
}

function compactAnalysis(config = {}, analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    contractCount: analysis.contractCount || 0,
    okContractCount: analysis.okContractCount || 0,
    uniqueDocsPathCount: analysis.uniqueDocsPathCount || 0,
    docsFileCount: analysis.docsFileCount || 0,
    sectionCount: analysis.sectionCount || 0,
    ...Object.fromEntries(sentenceBindings(config).map((binding) => [
      `${binding.key}Count`,
      analysis[`${binding.key}Count`] || 0,
    ])),
    orderCount: analysis.orderCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      docsPath: item.docsPath || null,
    })),
  };
}

function runScenario(config = {}, scenario = {}, baseInput = {}) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeSentenceSections(config, input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const slug = sectionSlug(config);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      `${slug}_scenario_unexpectedly_passed`,
      `${scenario.scenarioId} must fail report contract docs page ${config.sectionKindLabel} analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      `${slug}_expected_blocker_missing`,
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? `blocked_${slug}_scenario` : `pass_${slug}_scenario`,
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(config, analysis),
    blockers,
  };
}

export function buildSentenceSectionRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    docsByPath: { ...(docsByPath || {}) },
    docPathOverrides: { ...(docPathOverrides || {}) },
  };
}

export function buildSentenceSectionRegressionReport(config = {}, {
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  requiredConfig(config);
  const scenarios = config.negativeScenarios || buildSentenceSectionRegressionScenarios(config);
  const baseInput = buildSentenceSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeSentenceSections(config, baseInput);
  const scenarioReports = scenarios.map((scenario) => runScenario(config, scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: config.actualBlockerSource || `actual_${sectionSlug(config)}s`,
    })),
    ...scenarioReports.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: config.version,
    kind: config.kind,
    status: blockers.length ? `blocked_${sectionSlug(config)}_regression` : `pass_${sectionSlug(config)}_regression`,
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: config.reportFileId,
    scriptId: config.scriptId,
    fixture: {
      expectedScenarioCount: scenarios.length,
      scenarioIds: scenarios.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: scenarios.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: config.headingPrefix,
      requiredSentences: sentenceBindings(config).map((binding) => ({
        key: binding.key,
        label: binding.label,
        blockerCode: binding.blockerCode,
        sentence: binding.sentence,
      })),
    },
    actual: {
      ...compactAnalysis(config, actual),
      contracts: actual.contracts.map((contract) => compactContract(config, contract)),
    },
    scenarios: scenarioReports,
    summary: {
      actualOk: actual.ok === true,
      contractCount: actual.contractCount,
      okContractCount: actual.okContractCount,
      uniqueDocsPathCount: actual.uniqueDocsPathCount,
      docsFileCount: actual.docsFileCount,
      sectionCount: actual.sectionCount,
      ...Object.fromEntries(sentenceBindings(config).map((binding) => [
        `${binding.key}Count`,
        actual[`${binding.key}Count`],
      ])),
      orderCount: actual.orderCount,
      expectedScenarioCount: scenarios.length,
      scenarioCount: scenarioReports.length,
      passedScenarioCount: scenarioReports.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarioReports.filter((scenario) => !scenario.ok).length,
      observedExpectedBlockerCount: scenarioReports.filter((scenario) => (
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
      ...(config.extraSafetyFlags || {}),
      grantsExecutionPermission: false,
    },
  };
  const reportHash = digest({
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
      blockerCodes: scenario.blockers.map((item) => item.code),
    })),
    summary: report.summary,
    blockers: report.blockers.map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      scenarioId: item.scenarioId || null,
      docsPath: item.docsPath || null,
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    [config.hashField]: reportHash,
    hash: reportHash,
  };
}

export function summarizeSentenceSectionRegressionReport(config = {}, report = {}) {
  requiredConfig(config);
  return {
    ok: report.ok === true,
    status: report.status || null,
    [config.hashField]: report?.[config.hashField] || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(sentenceBindings(config).map((binding) => [
      `${binding.key}Count`,
      report.summary?.[`${binding.key}Count`] ?? null,
    ])),
    orderCount: report.summary?.orderCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
