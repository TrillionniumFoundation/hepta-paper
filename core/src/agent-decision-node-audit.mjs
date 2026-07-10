import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { digest } from './hash-utils.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

export const AGENT_DECISION_NODE_AUDIT_VERSION = 10;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRITICAL_DECISION_NODES = Object.freeze([
  {
    id: 'product_line_router',
    file: 'src/product-router.mjs',
    expectedAuthority: 'explicit_structured_or_agent_semantic_route',
    mustContain: [
      'semanticRoute',
      'agentSemanticRouteRequired: true',
      'textRegexRoutingEnabled: false',
      'textKeywordRoutingEnabled: false',
      'agent_semantic_route_required',
    ],
    forbidden: [
      'ROUTE_RULES',
      'primary_text',
      'secondary_requirement_text',
      'fallback_inference',
      'title_category_or_production_type_signal',
      'requirement_or_deliverable_signal',
      '.test(',
      'new RegExp',
    ],
  },
  {
    id: 'workflow_id_inference',
    file: 'src/contracts.mjs',
    expectedAuthority: 'enumerated_product_line_or_alias_only',
    functionName: 'inferProductLineFromWorkflow',
    mustContain: [
      'canonicalProductLineId(id)',
      'GENERIC_DESIGN',
    ],
    forbidden: [
      '.test(',
      'new RegExp',
      '/logo',
      '/packag',
      '/proposal',
      '/poster',
      '/deck',
      '/catalog',
      '/naming',
      '/vector',
      '/customer',
    ],
  },
  {
    id: 'human_feedback_chain_detection',
    file: 'src/contracts.mjs',
    expectedAuthority: 'canonical_alias_or_explicit_contract_only',
    functionName: 'isHumanFeedbackSignal',
    mustContain: [
      'canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK',
    ],
    forbidden: [
      '.test(',
      'new RegExp',
      '/customer',
      '/feedback',
      '/revision',
    ],
  },
  {
    id: 'plan_only_adapter',
    file: 'src/plan-only.mjs',
    expectedAuthority: 'routeProductLine_contract_plus_workflow_registry',
    mustContain: [
      'routeProductLine(routeInputFromChannelTask(channelTask, routeInput))',
      'workflowProfileForRoute(routeDecision)',
      'generic_design_requires_clarification',
    ],
    forbidden: [
      'ROUTE_RULES',
      'new RegExp',
      'title_category_or_production_type_signal',
      'requirement_or_deliverable_signal',
    ],
  },
  {
    id: 'human_feedback_workflow_contract',
    file: 'src/human-feedback-contracts.mjs',
    expectedAuthority: 'canonical_alias_or_explicit_workflow_only',
    functionName: 'isHumanFeedbackWorkflow',
    mustContain: [
      'canonicalProductLineId(normalized) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK',
      'canonicalProductLineId(canonicalPackageRole(normalized)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK',
      'HUMAN_FEEDBACK_WORKFLOW_ALIASES.has(normalized.toLowerCase())',
    ],
    forbidden: [
      '.test(',
      'new RegExp',
      'customer.{0,24}',
      'consumer.{0,24}',
      'buyer.{0,24}',
      'feedback.{0,24}',
      'post[_ -]?',
      'shortlisted[_ -]?',
      'won[_ -]?',
    ],
  },
  {
    id: 'human_feedback_atomic_status_contract',
    file: 'src/human-feedback-contracts.mjs',
    expectedAuthority: 'enumerated_status_aliases_only',
    functionName: 'canonicalAtomicStatus',
    mustContain: [
      'ACTIVE_ATOMIC_STATUSES',
      'PENDING_ATOMIC_STATUSES',
      'DONE_ATOMIC_STATUS_PREFIXES',
    ],
    forbidden: [
      '.test(',
      'new RegExp',
    ],
  },
  {
    id: 'action_manifest_human_feedback_scope',
    file: 'src/action-manifest.mjs',
    expectedAuthority: 'canonical_product_line_or_explicit_human_feedback_contract_hash',
    functionName: 'isHumanFeedbackManifest',
    mustContain: [
      'isHumanFeedbackMessageActionAlias(requestedAction)',
      'canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK',
      'approvalFeedbackContractHashes(approvalPacket).length > 0',
      'evidenceFeedbackContractHashes(evidenceBundle).length > 0',
    ],
    forbidden: [
      '.test(',
      'new RegExp',
      'customer.{0,24}',
      'feedback.{0,24}',
    ],
  },
  {
    id: 'design_reference_resolver',
    file: 'src/llm-design-reference-resolver.mjs',
    expectedAuthority: 'llm_semantic_intake_model_locked',
    mustContain: [
      "routingMode: 'model_semantic_locked'",
      "selectionAuthority: 'semantic_intake'",
      'indexOverrideAllowed: false',
      'regexMayOverride: false',
    ],
    forbidden: [
      'indexOverrideAllowed: true',
      'regexMayOverride: true',
    ],
  },
  {
    id: 'workflow_registry',
    file: 'src/workflow-registry.mjs',
    expectedAuthority: 'declarative_profile_registry',
    mustContain: [
      'semanticPolicy',
      'modelBacked',
      'DIRECT_EXTERNAL_ACTIONS_BLOCKED',
    ],
    forbidden: [
      'ROUTE_RULES',
      'new RegExp',
    ],
  },
  {
    id: 'channel_pipeline_contract',
    file: 'src/channel-production-pipeline.mjs',
    expectedAuthority: 'declarative_channel_contract_no_live_action',
    mustContain: [
      'executeOutsideCore: true',
      'coreOnlyBuildsHandoff: true',
      'executesExternalAction: false',
      'grantsExecutionPermission: false',
    ],
    forbidden: [
      'ROUTE_RULES',
      'new RegExp',
    ],
  },
  {
    id: 'channel_adapter_interface',
    file: 'src/channel-adapter-interface.mjs',
    expectedAuthority: 'declarative_channel_action_contract',
    mustContain: [
      'channelId',
      'actionId',
      'externalAction',
      'supportedActions',
    ],
    forbidden: [
      'ROUTE_RULES',
      'new RegExp',
      'title_category_or_production_type_signal',
      'requirement_or_deliverable_signal',
    ],
  },
  {
    id: 'channel_state_proof_submission_confirmation',
    file: 'src/channel-state-proof.mjs',
    expectedAuthority: 'structured_state_code_and_submission_confirmation_fields',
    functionName: 'actionSpecificBlockers',
    mustContain: [
      'submissionConfirmed',
      'SUBMISSION_NOT_CONFIRMED_STATE_CODES.has(evidence.stateCode)',
    ],
    forbidden: [
      '.test(',
      'new RegExp',
      'not\\s*found',
      'no_my_works_records|',
    ],
  },
  {
    id: 'execution_gate',
    file: 'src/execution-gates.mjs',
    expectedAuthority: 'approval_evidence_contract_gate',
    mustContain: [
      'approval',
      'evidence',
      'fresh',
    ],
    forbidden: [
      'ROUTE_RULES',
      'title_category_or_production_type_signal',
      'requirement_or_deliverable_signal',
    ],
  },
  {
    id: 'adapter_dispatch_assignment',
    file: 'src/adapter-dispatch-assignment.mjs',
    expectedAuthority: 'capability_and_current_approval_contract',
    mustContain: [
      'runnerId',
      'capability',
      'externalRunnerMustRecheckApproval: true',
      'externalRunnerMustRecheckEvidence: true',
      'externalRunnerMustRecheckChannelState: true',
    ],
    forbidden: [
      'ROUTE_RULES',
      'title_category_or_production_type_signal',
      'requirement_or_deliverable_signal',
    ],
  },
  {
    id: 'adapter_runner_registry',
    file: 'src/adapter-runner-registry.mjs',
    expectedAuthority: 'declared_runner_capability_registry',
    mustContain: [
      'runnerId',
      'supportedActionIds',
      'capability',
    ],
    forbidden: [
      'ROUTE_RULES',
      'new RegExp',
      'title_category_or_production_type_signal',
      'requirement_or_deliverable_signal',
    ],
  },
]);

const ROUTE_SENSITIVE_DECISION_FILES = Object.freeze([
  'src/action-manifest.mjs',
  'src/adapter-dispatch-assignment.mjs',
  'src/adapter-dispatch-envelope.mjs',
  'src/adapter-dispatch-readiness-report.mjs',
  'src/adapter-receipt.mjs',
  'src/adapter-runner-capabilities.mjs',
  'src/adapter-runner-registry.mjs',
  'src/adapter-runner-sdk.mjs',
  'src/adapter-runner.mjs',
  'src/channel-adapter-interface.mjs',
  'src/channel-production-pipeline.mjs',
  'src/channel-state-proof.mjs',
  'src/contracts.mjs',
  'src/human-feedback-contracts.mjs',
  'src/design-reference-adapter.mjs',
  'src/design-reference-contracts.mjs',
  'src/execution-gates.mjs',
  'src/external-action-audit-archive.mjs',
  'src/external-action-audit-bundle.mjs',
  'src/external-action-ledger.mjs',
  'src/external-action-lifecycle-schema.mjs',
  'src/external-action-lifecycle.mjs',
  'src/external-action-replay-guard.mjs',
  'src/llm-design-reference-resolver.mjs',
  'src/migration-shims.mjs',
  'src/plan-only.mjs',
  'src/product-router.mjs',
  'src/receipt-state-transition-inbox.mjs',
  'src/state-machine.mjs',
  'src/workflow-registry.mjs',
]);

const ROUTE_TEXT_TOKEN_PATTERN = /(logo|brand|packag|proposal|poster|deck|catalog|brochure|naming|vector|customer|consumer|buyer|feedback|revision|submission|shortlisted|workflow|product[_-]?line|category|requirement)/i;
const ROUTE_KEYWORD_LITERAL_PATTERN = /(['"`])(?:(?!\1).)*(logo|brand|packag|proposal|poster|deck|catalog|brochure|naming|vector|customer|consumer|buyer|feedback|revision|submission|shortlisted|workflow|product[_-]?line|category|requirement)(?:(?!\1).)*\1/i;
const ROUTE_KEYWORD_PROPERTY_PATTERN = /^[\s{,]*(logo|brand|packag|proposal|poster|deck|catalog|brochure|naming|vector|customer|consumer|buyer|feedback|revision|submission|shortlisted|workflow|product[_-]?line|category|requirement)[\w-]*\s*:/i;
const KEYWORD_OPERATOR_PATTERN = /\.(?:includes|startsWith|endsWith|indexOf)\(/;
const ROUTE_KEYWORD_EQUALITY_PATTERN = /(?:={2,3}|!==?)/;
const ROUTE_KEYWORD_LOOKUP_PATTERN = /\[[^\]]+\]|\.\s*get\s*\(/;
const SWITCH_EXPRESSION_PATTERN = /\bswitch\s*\(([^)]*)\)/;
const UNSTRUCTURED_TEXT_SOURCE_FIELDS = Object.freeze([
  'title',
  'taskTitle',
  'task_title',
  'categoryTitle',
  'rawCategory',
  'category',
  'requirementText',
  'description',
  'stateText',
  'statusText',
  'messageText',
  'previewText',
]);
const UNSTRUCTURED_TEXT_SOURCE_PATTERN = new RegExp(`\\b(${UNSTRUCTURED_TEXT_SOURCE_FIELDS.join('|')})\\b`);
const UNSTRUCTURED_TEXT_SOURCE_NAME_PATTERN = new RegExp(`^(${UNSTRUCTURED_TEXT_SOURCE_FIELDS.join('|')})$`);
const DECLARATIVE_MEMBERSHIP_PATTERN = /\b(Object\.values|knownStages|knownActions|allowedActionsForPolicy|supportedChannels|supportedActions|supportedActionIds|unsupportedActions|requiredHashBindings|consumes|produces|blockers|warnings|artifactNames|sourceRefs|CHANNEL_IDS|EXTERNAL_ACTIONS|PRODUCT_LINE_IDS|HUMAN_FEEDBACK_WORKFLOW_ALIASES|ACTIVE_ATOMIC_STATUSES|PENDING_ATOMIC_STATUSES|DONE_ATOMIC_STATUS_PREFIXES|SUBMISSION_NOT_CONFIRMED_STATE_CODES)\b/;
const IDENTIFIER_PATTERN = '[A-Za-z_$][\\w$]*';
const DECLARED_ALIAS_PATTERN = new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER_PATTERN})\\s*=`);
const ASSIGNED_ALIAS_PATTERN = new RegExp(`^\\s*(${IDENTIFIER_PATTERN})\\s*=(?!=)`);
const DESTRUCTURED_ALIAS_PATTERN = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=/;

function lineHasRegexOperator(line) {
  return line.includes('new RegExp')
    || line.includes('.test(')
    || line.includes('.match(')
    || /(^|[=(,:]\s*)\/(?![/*])/.test(line.trim());
}

function routeRegexScanFindings() {
  const findings = [];
  for (const file of ROUTE_SENSITIVE_DECISION_FILES) {
    const source = readText(file);
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (!lineHasRegexOperator(line)) return;
      if (!ROUTE_TEXT_TOKEN_PATTERN.test(line)) return;
      if (line.includes('regexMayOverride: false')) return;
      if (line.includes('regex/refpack-index routing is disabled')) return;
      findings.push({
        code: 'route_sensitive_regex_or_text_operator_present',
        file,
        line: index + 1,
        snippet: line.trim().slice(0, 180),
      });
    });
  }
  return findings;
}

function lineForDecisionScan(line) {
  return line.trim().startsWith('//') ? '' : line.replace(/\s*\/\/.*$/, '');
}

function escapedIdentifierPattern(identifier) {
  return new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

function lineUsesTaintedAlias(line, taintedAliases) {
  for (const alias of taintedAliases) {
    if (escapedIdentifierPattern(alias).test(line)) return alias;
  }
  return null;
}

function destructuredTaintedAliasesOnLine(line) {
  const match = line.match(DESTRUCTURED_ALIAS_PATTERN);
  if (!match) return [];
  return match[1].split(',').flatMap((entry) => {
    const normalized = entry.trim();
    if (!normalized) return [];
    const fieldMatch = normalized.match(new RegExp(`^(${IDENTIFIER_PATTERN})(?:\\s*:\\s*(${IDENTIFIER_PATTERN}))?`));
    if (!fieldMatch) return [];
    const sourceField = fieldMatch[1];
    if (!UNSTRUCTURED_TEXT_SOURCE_NAME_PATTERN.test(sourceField)) return [];
    return [fieldMatch[2] || sourceField];
  });
}

function taintedAliasesDeclaredOnLine(line, taintedAliases) {
  const aliases = destructuredTaintedAliasesOnLine(line);
  const declared = line.match(DECLARED_ALIAS_PATTERN) || line.match(ASSIGNED_ALIAS_PATTERN);
  if (declared) {
    const alias = declared[1];
    const rhs = line.slice(line.indexOf('=') + 1);
    if (UNSTRUCTURED_TEXT_SOURCE_PATTERN.test(rhs) || lineUsesTaintedAlias(rhs, taintedAliases)) {
      aliases.push(alias);
    }
  }
  return aliases;
}

function routeKeywordAliasesDeclaredOnLine(line, routeKeywordAliases) {
  const declared = line.match(DECLARED_ALIAS_PATTERN) || line.match(ASSIGNED_ALIAS_PATTERN);
  if (!declared) return [];
  const alias = declared[1];
  const rhs = line.slice(line.indexOf('=') + 1);
  if (ROUTE_KEYWORD_LITERAL_PATTERN.test(rhs) || ROUTE_KEYWORD_PROPERTY_PATTERN.test(rhs)) return [alias];
  const inheritedAlias = lineUsesTaintedAlias(rhs, routeKeywordAliases);
  if (inheritedAlias) {
    const rhsExpression = rhs.trim().replace(/[;,]$/, '');
    if (
      rhsExpression === inheritedAlias
      || rhsExpression === `[...${inheritedAlias}]`
      || rhsExpression === `Array.from(${inheritedAlias})`
      || rhsExpression === `new Set(${inheritedAlias})`
    ) {
      return [alias];
    }
  }
  return [];
}

function routeKeywordCollectionStartedOnLine(line) {
  const declared = line.match(DECLARED_ALIAS_PATTERN) || line.match(ASSIGNED_ALIAS_PATTERN);
  if (!declared) return null;
  const rhs = line.slice(line.indexOf('=') + 1);
  const rhsStart = rhs.trim();
  if (!/^(?:Object\.freeze\(\s*)?(?:new (?:Set|Map)\(\s*)?[\[{]/.test(rhsStart)) return null;
  if (/[\]}]/.test(rhsStart) && !ROUTE_KEYWORD_LITERAL_PATTERN.test(rhsStart) && !ROUTE_KEYWORD_PROPERTY_PATTERN.test(rhsStart)) return null;
  return declared[1];
}

function scanRouteSensitiveSourceText({ file, source }) {
  const findings = [];
  let allowedDeclarativeMembershipCount = 0;
  const taintedAliases = new Set();
  const routeKeywordAliases = new Set();
  const pendingRouteKeywordCollections = new Set();
  let taintedSwitchActive = false;
  const lines = source.split('\n');
  lines.forEach((rawLine, index) => {
    const line = lineForDecisionScan(rawLine);
    if (!line) return;
    for (const taintedAlias of taintedAliasesDeclaredOnLine(line, taintedAliases)) {
      taintedAliases.add(taintedAlias);
    }
    for (const routeKeywordAlias of routeKeywordAliasesDeclaredOnLine(line, routeKeywordAliases)) {
      routeKeywordAliases.add(routeKeywordAlias);
    }
    const pendingRouteKeywordAlias = routeKeywordCollectionStartedOnLine(line);
    if (pendingRouteKeywordAlias) pendingRouteKeywordCollections.add(pendingRouteKeywordAlias);
    if (pendingRouteKeywordCollections.size && (
      ROUTE_KEYWORD_LITERAL_PATTERN.test(line)
      || ROUTE_KEYWORD_PROPERTY_PATTERN.test(line)
    )) {
      for (const routeKeywordAlias of pendingRouteKeywordCollections) routeKeywordAliases.add(routeKeywordAlias);
    }
    const routeTokenPresent = ROUTE_TEXT_TOKEN_PATTERN.test(line);
    const routeKeywordLiteralPresent = ROUTE_KEYWORD_LITERAL_PATTERN.test(line);
    const usesDirectUnstructuredText = UNSTRUCTURED_TEXT_SOURCE_PATTERN.test(line);
    const taintedAliasUsed = lineUsesTaintedAlias(line, taintedAliases);
    const routeKeywordAliasUsed = lineUsesTaintedAlias(line, routeKeywordAliases);
    const routeTextKeyUsed = usesDirectUnstructuredText || taintedAliasUsed;
    if (
      routeKeywordAliasUsed
      && routeTextKeyUsed
      && ROUTE_KEYWORD_LOOKUP_PATTERN.test(line)
    ) {
      findings.push({
        code: 'route_sensitive_route_keyword_lookup_present',
        file,
        line: index + 1,
        alias: routeKeywordAliasUsed,
        routeTextAlias: taintedAliasUsed || undefined,
        snippet: line.trim().slice(0, 180),
      });
      return;
    }
    const switchExpression = line.match(SWITCH_EXPRESSION_PATTERN)?.[1] || '';
    if (switchExpression && (
      UNSTRUCTURED_TEXT_SOURCE_PATTERN.test(switchExpression)
      || lineUsesTaintedAlias(switchExpression, taintedAliases)
    )) {
      taintedSwitchActive = true;
    }
    if (taintedSwitchActive && /\bcase\b/.test(line) && routeKeywordLiteralPresent) {
      findings.push({
        code: 'route_sensitive_route_keyword_switch_case_present',
        file,
        line: index + 1,
        snippet: line.trim().slice(0, 180),
      });
      return;
    }
    if (
      ROUTE_KEYWORD_EQUALITY_PATTERN.test(line)
      && (routeKeywordLiteralPresent || routeKeywordAliasUsed)
      && (usesDirectUnstructuredText || taintedAliasUsed)
    ) {
      findings.push({
        code: routeKeywordAliasUsed
          ? 'route_sensitive_route_keyword_alias_equality_present'
          : 'route_sensitive_route_keyword_equality_present',
        file,
        line: index + 1,
        alias: routeKeywordAliasUsed || taintedAliasUsed || undefined,
        snippet: line.trim().slice(0, 180),
      });
      return;
    }
    if (taintedSwitchActive && line.includes('}')) taintedSwitchActive = false;
    if (pendingRouteKeywordCollections.size && /[\]}]/.test(line)) pendingRouteKeywordCollections.clear();
    if (!KEYWORD_OPERATOR_PATTERN.test(line)) return;
    if (routeTokenPresent && usesDirectUnstructuredText) {
      findings.push({
        code: 'route_sensitive_keyword_or_string_operator_present',
        file,
        line: index + 1,
        snippet: line.trim().slice(0, 180),
      });
      return;
    }
    if (routeTokenPresent && taintedAliasUsed) {
      findings.push({
        code: 'route_sensitive_tainted_keyword_operator_present',
        file,
        line: index + 1,
        alias: taintedAliasUsed,
        snippet: line.trim().slice(0, 180),
      });
      return;
    }
    if (routeKeywordAliasUsed && !DECLARATIVE_MEMBERSHIP_PATTERN.test(line)) {
      findings.push({
        code: 'route_sensitive_route_keyword_alias_operator_present',
        file,
        line: index + 1,
        alias: routeKeywordAliasUsed,
        snippet: line.trim().slice(0, 180),
      });
      return;
    }
    if (routeTokenPresent && !DECLARATIVE_MEMBERSHIP_PATTERN.test(line)) {
      findings.push({
        code: 'route_sensitive_route_keyword_operator_present',
        file,
        line: index + 1,
        snippet: line.trim().slice(0, 180),
      });
      return;
    }
    if (DECLARATIVE_MEMBERSHIP_PATTERN.test(line)) {
      allowedDeclarativeMembershipCount += 1;
    }
  });
  return {
    allowedDeclarativeMembershipCount,
    taintedAliasCount: taintedAliases.size,
    routeKeywordAliasCount: routeKeywordAliases.size,
    findings,
  };
}

export function scanRouteSensitiveSourceForTest({ file = 'src/product-router.mjs', source }) {
  if (typeof source !== 'string') {
    throw new TypeError('scanRouteSensitiveSourceForTest requires a source string');
  }
  return scanRouteSensitiveSourceText({ file, source });
}

function routeKeywordScan() {
  const findings = [];
  let allowedDeclarativeMembershipCount = 0;
  let taintedAliasCount = 0;
  let routeKeywordAliasCount = 0;
  for (const file of ROUTE_SENSITIVE_DECISION_FILES) {
    const scan = scanRouteSensitiveSourceText({ file, source: readText(file) });
    allowedDeclarativeMembershipCount += scan.allowedDeclarativeMembershipCount;
    taintedAliasCount += scan.taintedAliasCount;
    routeKeywordAliasCount += scan.routeKeywordAliasCount;
    findings.push(...scan.findings);
  }
  return {
    allowedDeclarativeMembershipCount,
    taintedAliasCount,
    routeKeywordAliasCount,
    taintedKeywordFindingCount: findings.filter((finding) => finding.code === 'route_sensitive_tainted_keyword_operator_present').length,
    routeKeywordAliasFindingCount: findings.filter((finding) => finding.code === 'route_sensitive_route_keyword_alias_operator_present').length,
    routeKeywordBranchFindingCount: findings.filter((finding) => (
      finding.code === 'route_sensitive_route_keyword_equality_present'
        || finding.code === 'route_sensitive_route_keyword_alias_equality_present'
        || finding.code === 'route_sensitive_route_keyword_switch_case_present'
    )).length,
    routeKeywordLookupFindingCount: findings.filter((finding) => finding.code === 'route_sensitive_route_keyword_lookup_present').length,
    findings,
  };
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function functionBody(source, functionName) {
  if (!functionName) return source;
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const parenStart = source.indexOf('(', start);
  if (parenStart < 0) return '';
  let parenDepth = 0;
  let signatureEnd = -1;
  for (let index = parenStart; index < source.length; index += 1) {
    if (source[index] === '(') parenDepth += 1;
    if (source[index] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnd = index;
        break;
      }
    }
  }
  if (signatureEnd < 0) return '';
  const braceStart = source.indexOf('{', signatureEnd);
  if (braceStart < 0) return '';
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

function auditNode(node) {
  const source = readText(node.file);
  const scope = functionBody(source, node.functionName);
  const blockers = [];
  const warnings = [];
  for (const token of node.mustContain || []) {
    if (!scope.includes(token)) {
      blockers.push({
        code: 'agent_decision_required_marker_missing',
        token,
      });
    }
  }
  for (const token of node.forbidden || []) {
    if (scope.includes(token)) {
      blockers.push({
        code: 'regex_or_keyword_routing_marker_present',
        token,
      });
    }
  }
  if (!node.functionName && source.includes('.test(') && node.id !== 'product_line_router') {
    warnings.push({
      code: 'file_contains_regex_test_outside_audited_scope',
      notes: 'Review as validation/report syntax, not routing.',
    });
  }
  return {
    id: node.id,
    file: node.file,
    scope: node.functionName || 'file',
    expectedAuthority: node.expectedAuthority,
    ok: blockers.length === 0,
    blockers,
    warnings,
  };
}

export function buildAgentDecisionNodeAuditReport({ createdAt = new Date().toISOString() } = {}) {
  const nodes = CRITICAL_DECISION_NODES.map(auditNode);
  const nodeBlockers = nodes.flatMap((node) => node.blockers.map((blocker) => ({
    ...blocker,
    nodeId: node.id,
    file: node.file,
  })));
  const routeRegexFindings = routeRegexScanFindings();
  const routeKeywordScanResult = routeKeywordScan();
  const blockers = [
    ...nodeBlockers,
    ...routeRegexFindings.map((finding) => ({
      ...finding,
      nodeId: 'route_sensitive_source_scan',
    })),
    ...routeKeywordScanResult.findings.map((finding) => ({
      ...finding,
      nodeId: 'route_sensitive_keyword_scan',
    })),
  ];
  const report = {
    version: AGENT_DECISION_NODE_AUDIT_VERSION,
    kind: 'AgentDecisionNodeAuditReport',
    status: blockers.length ? 'blocked_agent_decision_node_audit' : 'pass_agent_decision_node_audit',
    ok: blockers.length === 0,
    createdAt,
    summary: {
      nodeCount: nodes.length,
      passCount: nodes.filter((node) => node.ok).length,
      failCount: nodes.filter((node) => !node.ok).length,
      blockerCount: blockers.length,
      scannedDecisionFileCount: ROUTE_SENSITIVE_DECISION_FILES.length,
      routeSensitiveRegexFindingCount: routeRegexFindings.length,
      routeSensitiveKeywordFindingCount: routeKeywordScanResult.findings.length,
      routeSensitiveTaintedAliasCount: routeKeywordScanResult.taintedAliasCount,
      taintedKeywordFindingCount: routeKeywordScanResult.taintedKeywordFindingCount,
      routeKeywordAliasCount: routeKeywordScanResult.routeKeywordAliasCount,
      routeKeywordAliasFindingCount: routeKeywordScanResult.routeKeywordAliasFindingCount,
      routeKeywordBranchFindingCount: routeKeywordScanResult.routeKeywordBranchFindingCount,
      routeKeywordLookupFindingCount: routeKeywordScanResult.routeKeywordLookupFindingCount,
      allowedDeclarativeMembershipCount: routeKeywordScanResult.allowedDeclarativeMembershipCount,
      regexRoutingAllowed: false,
      keywordRoutingAllowed: false,
      agentSemanticDecisionRequired: true,
    },
    nodes,
    routeSensitiveSourceScan: {
      scannedFiles: ROUTE_SENSITIVE_DECISION_FILES,
      regexFindings: routeRegexFindings,
      keywordFindings: routeKeywordScanResult.findings,
      taintedAliasCount: routeKeywordScanResult.taintedAliasCount,
      taintedKeywordFindingCount: routeKeywordScanResult.taintedKeywordFindingCount,
      routeKeywordAliasCount: routeKeywordScanResult.routeKeywordAliasCount,
      routeKeywordAliasFindingCount: routeKeywordScanResult.routeKeywordAliasFindingCount,
      routeKeywordBranchFindingCount: routeKeywordScanResult.routeKeywordBranchFindingCount,
      routeKeywordLookupFindingCount: routeKeywordScanResult.routeKeywordLookupFindingCount,
      allowedDeclarativeMembershipCount: routeKeywordScanResult.allowedDeclarativeMembershipCount,
    },
    blockers,
    safety: {
      localAuditOnly: true,
      callsProviderOrModel: false,
      opensBrowserOrPlatform: false,
      uploadsOrSubmits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      paysOrDeploys: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...report,
    auditHash: digest({
      version: report.version,
      kind: report.kind,
      status: report.status,
      summary: report.summary,
      nodes: report.nodes,
      routeSensitiveSourceScan: report.routeSensitiveSourceScan,
      blockers: report.blockers,
      safety: report.safety,
    }),
  };
}

export function agentDecisionNodeAuditMarkdown(report) {
  const lines = [
    '# Agent Decision Node Audit',
    '',
    `- status: ${report.status}`,
    `- ok: ${report.ok}`,
    `- auditHash: ${report.auditHash}`,
    `- nodeCount: ${report.summary.nodeCount}`,
    `- passCount: ${report.summary.passCount}`,
    `- failCount: ${report.summary.failCount}`,
    `- blockerCount: ${report.summary.blockerCount}`,
    `- scannedDecisionFileCount: ${report.summary.scannedDecisionFileCount}`,
    `- routeSensitiveRegexFindingCount: ${report.summary.routeSensitiveRegexFindingCount}`,
    `- routeSensitiveKeywordFindingCount: ${report.summary.routeSensitiveKeywordFindingCount}`,
    `- routeSensitiveTaintedAliasCount: ${report.summary.routeSensitiveTaintedAliasCount}`,
    `- taintedKeywordFindingCount: ${report.summary.taintedKeywordFindingCount}`,
    `- routeKeywordAliasCount: ${report.summary.routeKeywordAliasCount}`,
    `- routeKeywordAliasFindingCount: ${report.summary.routeKeywordAliasFindingCount}`,
    `- routeKeywordBranchFindingCount: ${report.summary.routeKeywordBranchFindingCount}`,
    `- routeKeywordLookupFindingCount: ${report.summary.routeKeywordLookupFindingCount}`,
    `- allowedDeclarativeMembershipCount: ${report.summary.allowedDeclarativeMembershipCount}`,
    `- regexRoutingAllowed: ${report.summary.regexRoutingAllowed}`,
    `- keywordRoutingAllowed: ${report.summary.keywordRoutingAllowed}`,
    `- agentSemanticDecisionRequired: ${report.summary.agentSemanticDecisionRequired}`,
    '',
    '## Decision Nodes',
    '',
  ];
  for (const node of report.nodes) {
    lines.push(`- ${node.ok ? 'PASS' : 'BLOCKED'} ${node.id} (${node.file}): ${node.expectedAuthority}`);
    if (node.blockers.length) {
      for (const blocker of node.blockers) lines.push(`  - blocker: ${blocker.code} ${blocker.token || ''}`.trimEnd());
    }
    if (node.warnings.length) {
      for (const warning of node.warnings) lines.push(`  - warning: ${warning.code}`);
    }
  }
  lines.push('', '## Route-Sensitive Source Scan', '');
  if (!report.routeSensitiveSourceScan.regexFindings.length) {
    lines.push('- PASS no regex/text operators in route-sensitive decision lines');
  } else {
    for (const finding of report.routeSensitiveSourceScan.regexFindings) {
      lines.push(`- BLOCKED regex ${finding.file}:${finding.line} ${finding.snippet}`);
    }
  }
  if (!report.routeSensitiveSourceScan.keywordFindings.length) {
    lines.push('- PASS no keyword/string operators over unstructured route text or tainted route-text aliases');
  } else {
    for (const finding of report.routeSensitiveSourceScan.keywordFindings) {
      lines.push(`- BLOCKED keyword ${finding.file}:${finding.line} ${finding.snippet}`);
    }
  }
  lines.push(`- tainted route-text aliases tracked: ${report.routeSensitiveSourceScan.taintedAliasCount}`);
  lines.push(`- route keyword aliases tracked: ${report.routeSensitiveSourceScan.routeKeywordAliasCount}`);
  lines.push(`- allowed declarative membership checks: ${report.routeSensitiveSourceScan.allowedDeclarativeMembershipCount}`);
  lines.push('', 'Safety: local audit only; no provider/model call, browser/platform action, upload, submit, IM, acceptance, payment, deployment, or execution permission.');
  return `${lines.join('\n')}\n`;
}

export function writeAgentDecisionNodeAuditReport({ outDir = path.join(repoRoot, 'reports') } = {}) {
  const report = buildAgentDecisionNodeAuditReport();
  const reportFiles = writeLatestReportPair({
    report,
    fileId: 'agent-decision-node-audit-latest.json',
    markdown: agentDecisionNodeAuditMarkdown(report),
    outputDir: outDir,
  });
  return {
    report,
    jsonPath: reportFiles.latestJson,
    mdPath: reportFiles.latestMd,
  };
}

if (isCliEntrypoint(import.meta.url)) {
  const strict = process.argv.includes('--strict');
  const { report, jsonPath, mdPath } = writeAgentDecisionNodeAuditReport();
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    auditHash: report.auditHash,
    summary: report.summary,
    files: {
      jsonPath: relativeToWorkspace(jsonPath),
      mdPath: relativeToWorkspace(mdPath),
    },
    blockers: report.blockers,
  }, null, 2));
  if (strict && !report.ok) process.exitCode = 1;
}
