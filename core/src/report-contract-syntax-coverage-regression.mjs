import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_REPORT_FILE_ID = 'report-contract-syntax-coverage-regression-latest.json';
export const REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_SCRIPT_ID = 'reports:contract-syntax-coverage-regression';
export const REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_STEP_ID = 'report_contract_syntax_coverage_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_doc_coverage_regression';

const CLI_ENTRYPOINT_HELPER_PATTERN = /if\s*\(\s*isCliEntrypoint\(import\.meta\.url\)\s*\)\s*main\(\);/;
const RAW_CLI_ENTRYPOINT_PATTERNS = Object.freeze([
  /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/,
  /`file:\/\/\$\{process\.argv\[1\]\}`/,
]);
const URL_PATHNAME_FROM_IMPORT_META_PATTERNS = Object.freeze([
  new RegExp('new\\s+URL\\([^\\n)]*import\\.meta\\.url[^\\n)]*\\)\\.' + 'pathname'),
]);
const DIRECT_WRITE_ALLOWED_FILE_IDS = Object.freeze([
  'src/local-file-lock.mjs',
  'src/report-output-writer.mjs',
]);
const DIRECT_WRITE_PATTERNS = Object.freeze([
  new RegExp('\\bfs\\.writeFileSync\\s*\\('),
  new RegExp('\\bfs\\.writeFile\\s*\\('),
]);
const FILESYSTEM_MUTATION_ALLOWED_BY_FILE_ID = Object.freeze({
  'src/local-file-lock.mjs': Object.freeze(['mkdirSync', 'writeFileSync', 'rmSync']),
  'src/report-output-writer.mjs': Object.freeze(['mkdirSync', 'writeFileSync', 'writeFile']),
  'src/prune-reports.mjs': Object.freeze(['mkdirSync', 'renameSync', 'rename']),
});
const FILESYSTEM_MUTATION_PATTERNS = Object.freeze([
  Object.freeze({ operationId: 'writeFileSync', pattern: new RegExp('\\bfs\\.writeFileSync\\s*\\(') }),
  Object.freeze({ operationId: 'writeFile', pattern: new RegExp('\\bfs\\.writeFile\\s*\\(') }),
  Object.freeze({ operationId: 'appendFileSync', pattern: new RegExp('\\bfs\\.appendFileSync\\s*\\(') }),
  Object.freeze({ operationId: 'appendFile', pattern: new RegExp('\\bfs\\.appendFile\\s*\\(') }),
  Object.freeze({ operationId: 'mkdirSync', pattern: new RegExp('\\bfs\\.mkdirSync\\s*\\(') }),
  Object.freeze({ operationId: 'mkdir', pattern: new RegExp('\\bfs\\.mkdir\\s*\\(') }),
  Object.freeze({ operationId: 'renameSync', pattern: new RegExp('\\bfs\\.renameSync\\s*\\(') }),
  Object.freeze({ operationId: 'rename', pattern: new RegExp('\\bfs\\.rename\\s*\\(') }),
  Object.freeze({ operationId: 'rmSync', pattern: new RegExp('\\bfs\\.rmSync\\s*\\(') }),
  Object.freeze({ operationId: 'rm', pattern: new RegExp('\\bfs\\.rm\\s*\\(') }),
  Object.freeze({ operationId: 'unlinkSync', pattern: new RegExp('\\bfs\\.unlinkSync\\s*\\(') }),
  Object.freeze({ operationId: 'unlink', pattern: new RegExp('\\bfs\\.unlink\\s*\\(') }),
  Object.freeze({ operationId: 'copyFileSync', pattern: new RegExp('\\bfs\\.copyFileSync\\s*\\(') }),
  Object.freeze({ operationId: 'copyFile', pattern: new RegExp('\\bfs\\.copyFile\\s*\\(') }),
  Object.freeze({ operationId: 'cpSync', pattern: new RegExp('\\bfs\\.cpSync\\s*\\(') }),
  Object.freeze({ operationId: 'cp', pattern: new RegExp('\\bfs\\.cp\\s*\\(') }),
]);
const CHILD_PROCESS_ALLOWED_FILE_IDS = Object.freeze([
  'src/integration-dependency-gate.mjs',
  'src/package-root-resolver.mjs',
  'src/read-only-core-gate.mjs',
  'src/release-final-settlement.mjs',
  'src/release-full-closeout.mjs',
  'src/selftest-lanes.mjs',
]);
const CHILD_PROCESS_ALLOWED_COMMAND_EXPRESSIONS_BY_FILE_ID = Object.freeze({
  'src/integration-dependency-gate.mjs': Object.freeze(['process.execPath']),
  'src/package-root-resolver.mjs': Object.freeze(['process.execPath']),
  'src/read-only-core-gate.mjs': Object.freeze(['process.execPath']),
  'src/release-final-settlement.mjs': Object.freeze(['process.execPath', "'git'", "'rg'", 'command']),
  'src/release-full-closeout.mjs': Object.freeze(["'npm'"]),
  'src/selftest-lanes.mjs': Object.freeze(['process.execPath']),
});
const CHILD_PROCESS_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'node_child_process_import', pattern: /from\s+['"]node:child_process['"]/ }),
  Object.freeze({ patternId: 'spawn_sync_call', pattern: new RegExp('\\bspawnSync\\s*\\(') }),
  Object.freeze({ patternId: 'exec_sync_call', pattern: new RegExp('\\bexecSync\\s*\\(') }),
  Object.freeze({ patternId: 'exec_file_sync_call', pattern: new RegExp('\\bexecFileSync\\s*\\(') }),
]);
const EXTERNAL_BOUNDARY_PROCESS_ENV_ALLOWED_FILE_IDS = Object.freeze([
  'src/release-final-settlement.mjs',
  'src/release-full-closeout.mjs',
]);
const NETWORK_API_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'node_http_import', pattern: /from\s+['"]node:https?['"]/ }),
  Object.freeze({ patternId: 'bare_http_import', pattern: /from\s+['"]https?['"]/ }),
  Object.freeze({ patternId: 'network_client_import', pattern: /from\s+['"](axios|got|node-fetch|undici)['"]/ }),
  Object.freeze({ patternId: 'network_client_require', pattern: new RegExp('require\\s*\\(\\s*[\'"](?:axios|got|node-fetch|undici|node:https?|https?)[\'"]\\s*\\)') }),
  Object.freeze({ patternId: 'fetch_call', pattern: new RegExp('\\bfetch\\s*\\(') }),
  Object.freeze({ patternId: 'xml_http_request_call', pattern: new RegExp('\\bXMLHttpRequest\\s*\\(') }),
  Object.freeze({ patternId: 'websocket_call', pattern: new RegExp('\\bWebSocket\\s*\\(') }),
  Object.freeze({ patternId: 'http_request_call', pattern: new RegExp('\\bhttps?\\.request\\s*\\(') }),
]);
const BROWSER_AUTOMATION_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'browser_automation_import', pattern: /from\s+['"](playwright|puppeteer|selenium-webdriver)['"]/ }),
  Object.freeze({ patternId: 'browser_automation_require', pattern: new RegExp('require\\s*\\(\\s*[\'"](?:playwright|puppeteer|selenium-webdriver)[\'"]\\s*\\)') }),
]);
const PROCESS_ENV_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'process_env_object_pass', pattern: new RegExp('\\benv\\s*:\\s*process\\.' + 'env\\b') }),
  Object.freeze({ patternId: 'process_env_reference', pattern: new RegExp('\\bprocess\\.' + 'env\\b') }),
  Object.freeze({ patternId: 'process_env_property_read', pattern: new RegExp('\\bprocess\\.' + 'env\\.[A-Za-z_][A-Za-z0-9_]*') }),
]);
const DYNAMIC_IMPORT_ALLOWED_FILE_IDS = Object.freeze([
  'src/export-package-surface.mjs',
  'src/package-root-resolver.mjs',
]);
const DYNAMIC_IMPORT_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'dynamic_import_call', pattern: new RegExp('\\bimport\\s*\\(\\s*(?!s\\))') }),
]);
const UNSAFE_DYNAMIC_CODE_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'eval_call', pattern: new RegExp('\\beval\\s*\\(') }),
  Object.freeze({ patternId: 'new_function_constructor', pattern: new RegExp('new\\s+Function\\b') }),
  Object.freeze({ patternId: 'node_vm_import', pattern: /from\s+['"]node:vm['"]/ }),
  Object.freeze({ patternId: 'bare_vm_import', pattern: /from\s+['"]vm['"]/ }),
  Object.freeze({ patternId: 'vm_run_call', pattern: new RegExp('\\bvm\\.(?:runInNewContext|runInThisContext|runInContext|runInThisContext|Script)\\b') }),
]);
const CRYPTO_ALLOWED_FILE_IDS = Object.freeze([
  'src/approval-packets.mjs',
  'src/hash-utils.mjs',
]);
const CRYPTO_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'node_crypto_import', pattern: /from\s+['"]node:crypto['"]/ }),
  Object.freeze({ patternId: 'bare_crypto_import', pattern: /from\s+['"]crypto['"]/ }),
  Object.freeze({ patternId: 'crypto_create_hash_call', pattern: new RegExp('\\bcrypto\\s*\\.\\s*createHash\\s*\\(') }),
]);
const RANDOMNESS_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'math_random_call', pattern: new RegExp('\\bMath\\s*\\.\\s*random\\s*\\(') }),
  Object.freeze({ patternId: 'random_uuid_call', pattern: new RegExp('\\brandomUUID\\s*\\(') }),
  Object.freeze({ patternId: 'random_bytes_call', pattern: new RegExp('\\brandomBytes\\s*\\(') }),
  Object.freeze({ patternId: 'random_int_call', pattern: new RegExp('\\brandomInt\\s*\\(') }),
  Object.freeze({ patternId: 'crypto_random_call', pattern: new RegExp('\\bcrypto\\s*\\.\\s*random[A-Za-z0-9_]*\\s*\\(') }),
  Object.freeze({ patternId: 'get_random_values_call', pattern: new RegExp('\\bgetRandomValues\\s*\\(') }),
]);
const DIRECT_PROCESS_EXIT_ALLOWED_FILE_IDS = Object.freeze([
  'src/export-channel-runner-coverage-matrix.mjs',
  'src/export-post-action-dispatch-completion-matrix.mjs',
  'src/export-post-action-reconciliation-matrix.mjs',
  'src/export-post-action-runtime-status.mjs',
  'src/package-root-resolver.mjs',
  'src/release-final-settlement.mjs',
  'src/release-full-closeout.mjs',
]);
const DIRECT_PROCESS_EXIT_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'direct_process_exit_call', pattern: new RegExp('\\bprocess\\s*\\.\\s*' + 'exit\\s*\\(') }),
]);
const PROCESS_ENV_MUTATION_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'process_env_property_assignment', pattern: new RegExp('\\bprocess\\s*\\.\\s*' + 'env\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*\\s*=') }),
  Object.freeze({ patternId: 'process_env_bracket_assignment', pattern: new RegExp("\\bprocess\\s*\\.\\s*" + "env\\s*\\[\\s*['\"][^'\"]+['\"]\\s*\\]\\s*=") }),
  Object.freeze({ patternId: 'process_env_delete', pattern: new RegExp('\\bdelete\\s+process\\s*\\.\\s*' + 'env(?:\\s*\\.|\\s*\\[)') }),
  Object.freeze({ patternId: 'object_assign_process_env', pattern: new RegExp('\\bObject\\s*\\.\\s*assign\\s*\\(\\s*process\\s*\\.\\s*' + 'env\\b') }),
  Object.freeze({ patternId: 'reflect_set_process_env', pattern: new RegExp('\\bReflect\\s*\\.\\s*set\\s*\\(\\s*process\\s*\\.\\s*' + 'env\\b') }),
]);
const ASYNC_TIMER_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'set_timeout_call', pattern: new RegExp('\\bset' + 'Timeout\\s*\\(') }),
  Object.freeze({ patternId: 'set_interval_call', pattern: new RegExp('\\bset' + 'Interval\\s*\\(') }),
  Object.freeze({ patternId: 'set_immediate_call', pattern: new RegExp('\\bset' + 'Immediate\\s*\\(') }),
  Object.freeze({ patternId: 'queue_microtask_call', pattern: new RegExp('\\bqueue' + 'Microtask\\s*\\(') }),
  Object.freeze({ patternId: 'process_next_tick_call', pattern: new RegExp('\\bprocess\\s*\\.\\s*next' + 'Tick\\s*\\(') }),
]);
const DESTRUCTIVE_COMMAND_STRING_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'rm_recursive_force_command', pattern: new RegExp('\\brm\\s+-(?:r' + 'f|fr)\\b') }),
  Object.freeze({ patternId: 'git_reset_hard_command', pattern: new RegExp('\\bgit\\s+reset\\s+--' + 'hard\\b') }),
  Object.freeze({ patternId: 'git_checkout_double_dash_command', pattern: new RegExp('\\bgit\\s+checkout\\s+--\\b') }),
  Object.freeze({ patternId: 'git_clean_force_command', pattern: new RegExp('\\bgit\\s+clean\\s+-[A-Za-z]*f[A-Za-z]*\\b') }),
  Object.freeze({ patternId: 'npm_publish_command', pattern: new RegExp('\\bnpm\\s+publish\\b') }),
  Object.freeze({ patternId: 'gh_release_command', pattern: new RegExp('\\bgh\\s+release\\b') }),
]);
const EXTERNAL_COMMAND_STRING_PATTERNS = Object.freeze([
  Object.freeze({ patternId: 'curl_command', pattern: new RegExp('\\bc' + 'url\\s+') }),
  Object.freeze({ patternId: 'wget_command', pattern: new RegExp('\\bw' + 'get\\s+') }),
  Object.freeze({ patternId: 'ssh_command', pattern: new RegExp('\\bs' + 'sh\\s+') }),
  Object.freeze({ patternId: 'scp_command', pattern: new RegExp('\\bs' + 'cp\\s+') }),
  Object.freeze({ patternId: 'rsync_command', pattern: new RegExp('\\br' + 'sync\\s+') }),
  Object.freeze({ patternId: 'git_remote_command', pattern: new RegExp('\\bgit\\s+(?:push|pull|fetch)\\b') }),
]);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_syntax_steps',
    label: 'A new manifest contract is added without source/exporter syntax coverage',
    expectedBlockerCode: 'report_contract_syntax_coverage_source_syntax_step_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_syntax_guard',
        label: 'Report future syntax guard',
        scriptId: 'reports:future-syntax-guard',
        exporterPath: 'src/export-report-future-syntax-guard.mjs',
        stepIds: ['report_future_syntax_guard_export'],
        fileId: 'report-future-syntax-guard-latest.json',
        stdoutHashField: 'futureSyntaxGuardHash',
        gateSummaryHashKey: 'reportFutureSyntaxGuardHash',
      });
      input.sourceFileIds.push('src/report-future-syntax-guard.mjs');
      input.sourceFileIds.push('src/export-report-future-syntax-guard.mjs');
    },
  }),
  Object.freeze({
    scenarioId: 'source_syntax_step_missing',
    label: 'A manifest contract loses its source syntax step',
    expectedBlockerCode: 'report_contract_syntax_coverage_source_syntax_step_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSteps = input.gateSteps
        .filter((step) => step.stepId !== sourceSyntaxStepId(contract));
    },
  }),
  Object.freeze({
    scenarioId: 'exporter_syntax_step_missing',
    label: 'A manifest contract loses its exporter syntax step',
    expectedBlockerCode: 'report_contract_syntax_coverage_exporter_syntax_step_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSteps = input.gateSteps
        .filter((step) => step.stepId !== exporterSyntaxStepId(contract));
    },
  }),
  Object.freeze({
    scenarioId: 'source_syntax_arg_missing',
    label: 'A manifest contract source syntax step stops checking the source module',
    expectedBlockerCode: 'report_contract_syntax_coverage_source_syntax_arg_missing',
    mutate(input) {
      const contract = targetContract(input);
      const sourcePath = sourcePathFor(contract);
      input.gateSteps = input.gateSteps.map((step) => (step.stepId === sourceSyntaxStepId(contract)
        ? { ...step, args: step.args.filter((arg) => arg !== sourcePath) }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'exporter_syntax_arg_missing',
    label: 'A manifest contract exporter syntax step stops checking the exporter module',
    expectedBlockerCode: 'report_contract_syntax_coverage_exporter_syntax_arg_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSteps = input.gateSteps.map((step) => (step.stepId === exporterSyntaxStepId(contract)
        ? { ...step, args: step.args.filter((arg) => arg !== contract.exporterPath) }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'exporter_syntax_before_source_syntax',
    label: 'A manifest contract exporter syntax step moves before source syntax',
    expectedBlockerCode: 'report_contract_syntax_coverage_source_before_exporter_order_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSteps = moveStepBefore(
        input.gateSteps,
        exporterSyntaxStepId(contract),
        sourceSyntaxStepId(contract),
      );
    },
  }),
  Object.freeze({
    scenarioId: 'export_before_exporter_syntax',
    label: 'A manifest contract export step moves before exporter syntax',
    expectedBlockerCode: 'report_contract_syntax_coverage_exporter_before_export_order_mismatch',
    mutate(input) {
      const contract = targetContract(input);
      input.gateSteps = moveStepBefore(
        input.gateSteps,
        contract.stepIds[0],
        exporterSyntaxStepId(contract),
      );
    },
  }),
  Object.freeze({
    scenarioId: 'source_file_missing',
    label: 'A manifest contract source module disappears',
    expectedBlockerCode: 'report_contract_syntax_coverage_source_file_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceFileIds = input.sourceFileIds.filter((fileId) => fileId !== sourcePathFor(contract));
    },
  }),
  Object.freeze({
    scenarioId: 'raw_cli_entrypoint_detection',
    label: 'A CLI source reintroduces raw process argv file URL entrypoint detection',
    expectedBlockerCode: 'report_contract_syntax_coverage_raw_cli_entrypoint_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = replaceCliEntrypointWithRawPattern(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'url_pathname_package_root_detection',
    label: 'A source reintroduces URL pathname package-root resolution',
    expectedBlockerCode: 'report_contract_syntax_coverage_url_pathname_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = replacePackageRootWithUrlPathname(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'direct_write_outside_shared_writer_detection',
    label: 'A source writes report output directly outside the shared writer',
    expectedBlockerCode: 'report_contract_syntax_coverage_direct_write_outside_shared_writer',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectDirectWriteFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'filesystem_mutation_outside_allowlist_detection',
    label: 'A source mutates local files outside the writer and retention allowlist',
    expectedBlockerCode: 'report_contract_syntax_coverage_filesystem_mutation_outside_allowlist',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectFilesystemMutationFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'child_process_outside_allowlist_detection',
    label: 'A source executes a child process outside local orchestration files',
    expectedBlockerCode: 'report_contract_syntax_coverage_child_process_outside_allowlist',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectChildProcessFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'child_process_command_operand_detection',
    label: 'An allowlisted child-process source introduces an unapproved command operand',
    expectedBlockerCode: 'report_contract_syntax_coverage_child_process_command_not_approved',
    mutate(input) {
      const fileId = 'src/release-final-settlement.mjs';
      if (!input.sourceFileIds.includes(fileId)) input.sourceFileIds.push(fileId);
      input.sourceTextsByFileId[fileId] = buildUnapprovedChildProcessCommandFixture();
    },
  }),
  Object.freeze({
    scenarioId: 'child_process_argv_operand_detection',
    label: 'An allowlisted child-process source keeps an approved command but introduces unapproved argv',
    expectedBlockerCode: 'report_contract_syntax_coverage_child_process_argv_not_approved',
    mutate(input) {
      const fileId = 'src/release-final-settlement.mjs';
      if (!input.sourceFileIds.includes(fileId)) input.sourceFileIds.push(fileId);
      input.sourceTextsByFileId[fileId] = buildUnapprovedChildProcessArgvFixture();
    },
  }),
  Object.freeze({
    scenarioId: 'child_process_options_operand_detection',
    label: 'An allowlisted child-process source keeps approved command and argv operands but introduces unapproved spawn options',
    expectedBlockerCode: 'report_contract_syntax_coverage_child_process_options_not_approved',
    mutate(input) {
      const fileId = 'src/release-final-settlement.mjs';
      if (!input.sourceFileIds.includes(fileId)) input.sourceFileIds.push(fileId);
      input.sourceTextsByFileId[fileId] = buildUnapprovedChildProcessOptionsFixture();
    },
  }),
  Object.freeze({
    scenarioId: 'child_process_result_handling_detection',
    label: 'An allowlisted child-process source spawns with approved operands but drops status/error/signal handling',
    expectedBlockerCode: 'report_contract_syntax_coverage_child_process_result_not_validated',
    mutate(input) {
      const fileId = 'src/read-only-core-gate.mjs';
      if (!input.sourceFileIds.includes(fileId)) input.sourceFileIds.push(fileId);
      input.sourceTextsByFileId[fileId] = buildUnvalidatedChildProcessResultFixture();
    },
  }),
  Object.freeze({
    scenarioId: 'network_api_detection',
    label: 'A source introduces a network API call',
    expectedBlockerCode: 'report_contract_syntax_coverage_network_api_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectNetworkApiFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'process_env_outside_allowlist_detection',
    label: 'A source reads inherited environment outside release orchestration files',
    expectedBlockerCode: 'report_contract_syntax_coverage_process_env_outside_allowlist',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectProcessEnvFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'dynamic_import_outside_allowlist_detection',
    label: 'A source dynamically imports a module outside local resolver/package-surface checks',
    expectedBlockerCode: 'report_contract_syntax_coverage_dynamic_import_outside_allowlist',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectDynamicImportFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'unsafe_dynamic_code_detection',
    label: 'A source introduces unsafe runtime code execution',
    expectedBlockerCode: 'report_contract_syntax_coverage_unsafe_dynamic_code_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectUnsafeDynamicCodeFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'crypto_outside_allowlist_detection',
    label: 'A source imports crypto outside deterministic hash helpers',
    expectedBlockerCode: 'report_contract_syntax_coverage_crypto_outside_allowlist',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectCryptoFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'randomness_detection',
    label: 'A source introduces runtime randomness',
    expectedBlockerCode: 'report_contract_syntax_coverage_randomness_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectRandomnessFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'direct_process_exit_outside_allowlist_detection',
    label: 'A source exits the process outside approved local orchestration files',
    expectedBlockerCode: 'report_contract_syntax_coverage_direct_process_exit_outside_allowlist',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectDirectProcessExitFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'process_env_mutation_detection',
    label: 'A source mutates inherited process environment',
    expectedBlockerCode: 'report_contract_syntax_coverage_process_env_mutation_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectProcessEnvMutationFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'async_timer_detection',
    label: 'A source introduces timer or microtask scheduling',
    expectedBlockerCode: 'report_contract_syntax_coverage_async_timer_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectAsyncTimerFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'destructive_command_string_detection',
    label: 'A source includes a destructive shell command string',
    expectedBlockerCode: 'report_contract_syntax_coverage_destructive_command_string_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectDestructiveCommandStringFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
    },
  }),
  Object.freeze({
    scenarioId: 'external_command_string_detection',
    label: 'A source includes an external network or remote shell command string',
    expectedBlockerCode: 'report_contract_syntax_coverage_external_command_string_detected',
    mutate(input) {
      const contract = targetContract(input);
      input.sourceTextsByFileId[contract.exporterPath] = injectExternalCommandStringFixture(
        input.sourceTextsByFileId[contract.exporterPath],
      );
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

function replaceCliEntrypointWithRawPattern(sourceText = '') {
  const rawPrefix = 'if (import.meta.url === `';
  const rawScheme = 'file://';
  const rawArg = '${process.argv[1]}';
  const rawSuffix = '`) main();';
  return String(sourceText || '').replace(
    CLI_ENTRYPOINT_HELPER_PATTERN,
    rawPrefix + rawScheme + rawArg + rawSuffix,
  );
}

function replacePackageRootWithUrlPathname(sourceText = '') {
  const rawPrefix = 'const packageRoot = new URL(';
  const rawParentArg = "'..'";
  const rawPathname = '.' + 'pathname';
  const rawSuffix = ', import.meta.url)' + rawPathname + ';';
  return String(sourceText || '').replace(
    /const packageRoot = path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\);/,
    rawPrefix + rawParentArg + rawSuffix,
  );
}

function injectDirectWriteFixture(sourceText = '') {
  const directWrite = 'fs.' + 'writeFileSync' + "('reports/synthetic-direct-write.json', '{}\\n');";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${directWrite}`,
  );
}

function injectFilesystemMutationFixture(sourceText = '') {
  const mutation = 'fs.' + 'renameSync' + "('reports/synthetic-source.json', 'reports/archive/synthetic-source.json');";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${mutation}`,
  );
}

function injectChildProcessFixture(sourceText = '') {
  const childProcess = 'spawn' + 'Sync' + "('npm', ['run', 'synthetic-child-process']);";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${childProcess}`,
  );
}

function buildUnapprovedChildProcessCommandFixture() {
  const importLine = "import { spawn" + "Sync } from 'node" + ":child_process';";
  const commandLine = "  spawn" + "Sync('python', ['synthetic-child-process-command']);";
  return [
    importLine,
    'function syntheticChildProcessCommandProbe() {',
    commandLine,
    '}',
    'syntheticChildProcessCommandProbe();',
    '',
  ].join('\n');
}

function buildUnapprovedChildProcessArgvFixture() {
  const importLine = "import { spawn" + "Sync } from 'node" + ":child_process';";
  const commandLine = "  spawn" + "Sync('git', ['clean', '-fd']);";
  return [
    importLine,
    'function syntheticChildProcessArgvProbe() {',
    commandLine,
    '}',
    'syntheticChildProcessArgvProbe();',
    '',
  ].join('\n');
}

function buildUnapprovedChildProcessOptionsFixture() {
  const importLine = "import { spawn" + "Sync } from 'node" + ":child_process';";
  const commandLine = "  spawn" + "Sync('git', ['diff', '--check', '--', '.'], { cwd: packageRoot, shell: true });";
  return [
    importLine,
    "const packageRoot = '/tmp/synthetic-package-root';",
    'function syntheticChildProcessOptionsProbe() {',
    commandLine,
    '}',
    'syntheticChildProcessOptionsProbe();',
    '',
  ].join('\n');
}

function buildUnvalidatedChildProcessResultFixture() {
  const importLine = "import { spawn" + "Sync } from 'node" + ":child_process';";
  const commandLine = "  spawn" + "Sync(process.execPath, ['src/selftest.mjs'], { cwd: packageRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });";
  return [
    importLine,
    "const packageRoot = '/tmp/synthetic-package-root';",
    'function syntheticChildProcessResultProbe() {',
    commandLine,
    '  return true;',
    '}',
    'syntheticChildProcessResultProbe();',
    '',
  ].join('\n');
}

function injectNetworkApiFixture(sourceText = '') {
  const networkCall = 'fetch' + "('https://example.invalid/synthetic-boundary');";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${networkCall}`,
  );
}

function injectProcessEnvFixture(sourceText = '') {
  const envRead = 'const syntheticEnv = process' + '.env;';
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${envRead}`,
  );
}

function injectDynamicImportFixture(sourceText = '') {
  const dynamicImport = 'await import' + "('synthetic-dynamic-module');";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${dynamicImport}`,
  );
}

function injectUnsafeDynamicCodeFixture(sourceText = '') {
  const unsafeDynamicCode = 'eval' + "('syntheticDynamicCode()');";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${unsafeDynamicCode}`,
  );
}

function injectCryptoFixture(sourceText = '') {
  const cryptoImport = "import crypto from 'node" + ":crypto';";
  return `${cryptoImport}\n${String(sourceText || '')}`;
}

function injectRandomnessFixture(sourceText = '') {
  const randomCall = 'Math' + '.random();';
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${randomCall}`,
  );
}

function injectDirectProcessExitFixture(sourceText = '') {
  const exitCall = 'process' + '.exit(1);';
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${exitCall}`,
  );
}

function injectProcessEnvMutationFixture(sourceText = '') {
  const envMutation = 'process' + ".env.SYNTHETIC_RUNTIME_SIDE_EFFECT = '1';";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${envMutation}`,
  );
}

function injectAsyncTimerFixture(sourceText = '') {
  const timerCall = 'set' + 'Timeout(() => {}, 0);';
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${timerCall}`,
  );
}

function injectDestructiveCommandStringFixture(sourceText = '') {
  const commandString = "const syntheticCommand = 'rm -" + "rf reports';";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${commandString}`,
  );
}

function injectExternalCommandStringFixture(sourceText = '') {
  const commandString = "const syntheticCommand = 'c" + "url https://example.invalid';";
  return String(sourceText || '').replace(
    'function main() {',
    `function main() {\n  ${commandString}`,
  );
}

function basenameWithoutExt(filePath = '') {
  return String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1)?.replace(/\.mjs$/, '') || '';
}

function sourcePathFor(contract = {}) {
  const exporterBase = basenameWithoutExt(contract.exporterPath);
  const sourceBase = exporterBase.startsWith('export-')
    ? exporterBase.slice('export-'.length)
    : exporterBase;
  return `src/${sourceBase}.mjs`;
}

function syntaxBaseIdFor(contract = {}) {
  return basenameWithoutExt(sourcePathFor(contract)).replace(/-/g, '_');
}

function sourceSyntaxStepId(contract = {}) {
  return `syntax_${syntaxBaseIdFor(contract)}`;
}

function exporterSyntaxStepId(contract = {}) {
  return `syntax_${syntaxBaseIdFor(contract)}_export`;
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    scriptId: contract.scriptId || null,
    exporterPath: contract.exporterPath || null,
    stepIds: Array.isArray(contract.stepIds) ? [...contract.stepIds] : [],
    sourcePath: sourcePathFor(contract),
    sourceSyntaxStepId: sourceSyntaxStepId(contract),
    exporterSyntaxStepId: exporterSyntaxStepId(contract),
  };
}

function stepIndexById(steps = []) {
  return Object.fromEntries(steps.map((step, index) => [step.stepId, index]));
}

function stepById(steps = []) {
  return Object.fromEntries(steps.map((step) => [step.stepId, step]));
}

function moveStepBefore(steps, movingStepId, anchorStepId) {
  const moving = steps.find((step) => step.stepId === movingStepId);
  if (!moving) return steps;
  const withoutMoving = steps.filter((step) => step.stepId !== movingStepId);
  const anchorIndex = withoutMoving.findIndex((step) => step.stepId === anchorStepId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex),
    moving,
    ...withoutMoving.slice(anchorIndex),
  ];
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function analyzeContract(contract, input = {}) {
  const steps = stepById(input.gateSteps || []);
  const indexById = stepIndexById(input.gateSteps || []);
  const sourceFileIds = new Set(input.sourceFileIds || []);
  const sourceSyntaxStep = steps[contract.sourceSyntaxStepId] || null;
  const exporterSyntaxStep = steps[contract.exporterSyntaxStepId] || null;
  const sourceSyntaxIndex = indexById[contract.sourceSyntaxStepId] ?? null;
  const exporterSyntaxIndex = indexById[contract.exporterSyntaxStepId] ?? null;
  const sourceFileExists = sourceFileIds.has(contract.sourcePath);
  const exporterFileExists = sourceFileIds.has(contract.exporterPath);
  const sourceSyntaxArgPresent = Boolean(sourceSyntaxStep)
    && sourceSyntaxStep.args.includes('--check')
    && sourceSyntaxStep.args.includes(contract.sourcePath);
  const exporterSyntaxArgPresent = Boolean(exporterSyntaxStep)
    && exporterSyntaxStep.args.includes('--check')
    && exporterSyntaxStep.args.includes(contract.exporterPath);
  const exportStepRecords = contract.stepIds.map((stepId) => {
    const step = steps[stepId] || null;
    const exportIndex = indexById[stepId] ?? null;
    return {
      stepId,
      present: Boolean(step),
      exportIndex,
      exporterBeforeExport: Number.isInteger(exporterSyntaxIndex)
        && Number.isInteger(exportIndex)
        && exporterSyntaxIndex < exportIndex,
    };
  });
  const sourceBeforeExporter = Number.isInteger(sourceSyntaxIndex)
    && Number.isInteger(exporterSyntaxIndex)
    && sourceSyntaxIndex < exporterSyntaxIndex;
  const blockers = [
    ...(sourceFileExists ? [] : [blocker(
      'report_contract_syntax_coverage_source_file_missing',
      `${contract.contractId} source module is missing: ${contract.sourcePath}.`,
      { contractId: contract.contractId, fileId: contract.sourcePath },
    )]),
    ...(exporterFileExists ? [] : [blocker(
      'report_contract_syntax_coverage_exporter_file_missing',
      `${contract.contractId} exporter module is missing: ${contract.exporterPath}.`,
      { contractId: contract.contractId, fileId: contract.exporterPath },
    )]),
    ...(sourceSyntaxStep ? [] : [blocker(
      'report_contract_syntax_coverage_source_syntax_step_missing',
      `${contract.contractId} must have gate syntax step ${contract.sourceSyntaxStepId}.`,
      { contractId: contract.contractId, stepId: contract.sourceSyntaxStepId },
    )]),
    ...(exporterSyntaxStep ? [] : [blocker(
      'report_contract_syntax_coverage_exporter_syntax_step_missing',
      `${contract.contractId} must have gate syntax step ${contract.exporterSyntaxStepId}.`,
      { contractId: contract.contractId, stepId: contract.exporterSyntaxStepId },
    )]),
    ...(sourceSyntaxArgPresent ? [] : [blocker(
      'report_contract_syntax_coverage_source_syntax_arg_missing',
      `${contract.sourceSyntaxStepId} must check ${contract.sourcePath}.`,
      { contractId: contract.contractId, stepId: contract.sourceSyntaxStepId, fileId: contract.sourcePath },
    )]),
    ...(exporterSyntaxArgPresent ? [] : [blocker(
      'report_contract_syntax_coverage_exporter_syntax_arg_missing',
      `${contract.exporterSyntaxStepId} must check ${contract.exporterPath}.`,
      { contractId: contract.contractId, stepId: contract.exporterSyntaxStepId, fileId: contract.exporterPath },
    )]),
    ...(sourceBeforeExporter ? [] : [blocker(
      'report_contract_syntax_coverage_source_before_exporter_order_mismatch',
      `${contract.sourceSyntaxStepId} must run before ${contract.exporterSyntaxStepId}.`,
      { contractId: contract.contractId, stepId: contract.exporterSyntaxStepId, previousStepId: contract.sourceSyntaxStepId },
    )]),
    ...exportStepRecords.filter((record) => !record.present).map((record) => blocker(
      'report_contract_syntax_coverage_export_step_missing',
      `${contract.contractId} gate export step is missing: ${record.stepId}.`,
      { contractId: contract.contractId, stepId: record.stepId },
    )),
    ...exportStepRecords.filter((record) => record.present && !record.exporterBeforeExport).map((record) => blocker(
      'report_contract_syntax_coverage_exporter_before_export_order_mismatch',
      `${contract.exporterSyntaxStepId} must run before ${record.stepId}.`,
      { contractId: contract.contractId, stepId: record.stepId, previousStepId: contract.exporterSyntaxStepId },
    )),
  ];
  return {
    contractId: contract.contractId,
    status: blockers.length ? 'blocked_report_contract_syntax_coverage_contract' : 'pass_report_contract_syntax_coverage_contract',
    ok: blockers.length === 0,
    sourcePath: contract.sourcePath,
    exporterPath: contract.exporterPath,
    sourceSyntaxStepId: contract.sourceSyntaxStepId,
    exporterSyntaxStepId: contract.exporterSyntaxStepId,
    stepIds: contract.stepIds,
    sourceFileExists,
    exporterFileExists,
    sourceSyntaxStepPresent: Boolean(sourceSyntaxStep),
    exporterSyntaxStepPresent: Boolean(exporterSyntaxStep),
    sourceSyntaxArgPresent,
    exporterSyntaxArgPresent,
    sourceBeforeExporter,
    exportStepCount: exportStepRecords.length,
    presentExportStepCount: exportStepRecords.filter((record) => record.present).length,
    exporterBeforeExportCount: exportStepRecords.filter((record) => record.exporterBeforeExport).length,
    blockers,
  };
}

function rawCliEntrypointPatternIds(sourceText = '') {
  return RAW_CLI_ENTRYPOINT_PATTERNS
    .map((pattern, index) => (pattern.test(String(sourceText || '')) ? `raw_cli_entrypoint_pattern_${index + 1}` : null))
    .filter(Boolean);
}

function cliEntrypointRecordFor(fileId, sourceText = '') {
  const rawPatternIds = rawCliEntrypointPatternIds(sourceText);
  const helperEntrypointPresent = CLI_ENTRYPOINT_HELPER_PATTERN.test(String(sourceText || ''));
  return {
    fileId,
    helperEntrypointPresent,
    rawPatternIds,
    cliEntrypointSource: helperEntrypointPresent || rawPatternIds.length > 0,
  };
}

function analyzeCliEntrypointPolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => cliEntrypointRecordFor(fileId, sourceText))
    .filter((record) => record.cliEntrypointSource);
  const rawRecords = records.filter((record) => record.rawPatternIds.length > 0);
  const blockers = rawRecords.map((record) => blocker(
    'report_contract_syntax_coverage_raw_cli_entrypoint_detected',
    `${record.fileId} must use isCliEntrypoint(import.meta.url) instead of raw process argv file URL comparison.`,
    { fileId: record.fileId, rawPatternIds: record.rawPatternIds },
  ));
  return {
    status: blockers.length ? 'blocked_report_contract_cli_entrypoint_policy' : 'pass_report_contract_cli_entrypoint_policy',
    ok: blockers.length === 0,
    cliEntrypointSourceCount: records.length,
    cliEntrypointHelperCount: records.filter((record) => record.helperEntrypointPresent).length,
    rawCliEntrypointCount: rawRecords.length,
    cliEntrypointSources: records,
    blockers,
  };
}

function urlPathnamePatternIds(sourceText = '') {
  return URL_PATHNAME_FROM_IMPORT_META_PATTERNS
    .map((pattern, index) => (pattern.test(String(sourceText || '')) ? `url_pathname_from_import_meta_pattern_${index + 1}` : null))
    .filter(Boolean);
}

function analyzeUrlPathnamePolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => ({
      fileId,
      rawPatternIds: urlPathnamePatternIds(sourceText),
    }))
    .filter((record) => record.rawPatternIds.length > 0);
  const blockers = records.map((record) => blocker(
    'report_contract_syntax_coverage_url_pathname_detected',
    `${record.fileId} must use fileURLToPath(import.meta.url) or URL objects instead of import.meta.url URL pathname resolution.`,
    { fileId: record.fileId, rawPatternIds: record.rawPatternIds },
  ));
  return {
    status: blockers.length ? 'blocked_report_contract_url_pathname_policy' : 'pass_report_contract_url_pathname_policy',
    ok: blockers.length === 0,
    urlPathnameSourceCount: records.length,
    urlPathnameSources: records,
    blockers,
  };
}

function directWritePatternIds(sourceText = '') {
  return DIRECT_WRITE_PATTERNS
    .map((pattern, index) => (pattern.test(String(sourceText || '')) ? `direct_write_pattern_${index + 1}` : null))
    .filter(Boolean);
}

function analyzeDirectWritePolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => ({
      fileId,
      allowed: DIRECT_WRITE_ALLOWED_FILE_IDS.includes(fileId),
      rawPatternIds: directWritePatternIds(sourceText),
    }))
    .filter((record) => record.rawPatternIds.length > 0);
  const blockers = records
    .filter((record) => !record.allowed)
    .map((record) => blocker(
      'report_contract_syntax_coverage_direct_write_outside_shared_writer',
      `${record.fileId} must route report output through src/report-output-writer.mjs instead of direct writeFile calls.`,
      { fileId: record.fileId, rawPatternIds: record.rawPatternIds },
    ));
  return {
    status: blockers.length ? 'blocked_report_contract_direct_write_policy' : 'pass_report_contract_direct_write_policy',
    ok: blockers.length === 0,
    directWriteSourceCount: records.length,
    allowedDirectWriteSourceCount: records.filter((record) => record.allowed).length,
    disallowedDirectWriteSourceCount: records.filter((record) => !record.allowed).length,
    directWriteSources: records,
    blockers,
  };
}

function filesystemMutationOperationIds(sourceText = '') {
  return FILESYSTEM_MUTATION_PATTERNS
    .map(({ operationId, pattern }) => (pattern.test(String(sourceText || '')) ? operationId : null))
    .filter(Boolean);
}

function analyzeFilesystemMutationPolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => {
      const operationIds = filesystemMutationOperationIds(sourceText);
      const allowedOperationIds = FILESYSTEM_MUTATION_ALLOWED_BY_FILE_ID[fileId] || [];
      const disallowedOperationIds = operationIds.filter((operationId) => !allowedOperationIds.includes(operationId));
      return {
        fileId,
        operationIds,
        allowedOperationIds: operationIds.filter((operationId) => allowedOperationIds.includes(operationId)),
        disallowedOperationIds,
        allowed: disallowedOperationIds.length === 0,
      };
    })
    .filter((record) => record.operationIds.length > 0);
  const blockers = records
    .filter((record) => !record.allowed)
    .map((record) => blocker(
      'report_contract_syntax_coverage_filesystem_mutation_outside_allowlist',
      `${record.fileId} must not call mutable fs APIs outside the report writer and retention allowlist.`,
      { fileId: record.fileId, operationIds: record.operationIds, disallowedOperationIds: record.disallowedOperationIds },
    ));
  return {
    status: blockers.length ? 'blocked_report_contract_filesystem_mutation_policy' : 'pass_report_contract_filesystem_mutation_policy',
    ok: blockers.length === 0,
    filesystemMutationSourceCount: records.length,
    allowedFilesystemMutationSourceCount: records.filter((record) => record.allowed).length,
    disallowedFilesystemMutationSourceCount: records.filter((record) => !record.allowed).length,
    filesystemMutationSources: records,
    blockers,
  };
}

function childProcessPatternIds(sourceText = '') {
  return CHILD_PROCESS_PATTERNS
    .map(({ patternId, pattern }) => (pattern.test(String(sourceText || '')) ? patternId : null))
    .filter(Boolean);
}

function normalizeCommandExpression(expression = '') {
  return String(expression || '').trim().replace(/\s+/g, ' ');
}

function readCallFirstArgument(text, startIndex) {
  return readCallArguments(text, startIndex)[0] || '';
}

function readCallArguments(text, startIndex) {
  let index = startIndex;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  let expressionStart = index;
  let quote = null;
  let escaped = false;
  let depth = 0;
  const args = [];
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) {
        const expression = normalizeCommandExpression(text.slice(expressionStart, index));
        if (expression) args.push(expression);
        break;
      }
      depth -= 1;
      continue;
    }
    if (character === ',' && depth === 0) {
      const expression = normalizeCommandExpression(text.slice(expressionStart, index));
      if (expression) args.push(expression);
      index += 1;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      expressionStart = index;
      index -= 1;
    }
  }
  return args;
}

function extractCallFirstArgumentRecords(sourceText = '', callName = '') {
  const text = String(sourceText || '');
  const pattern = new RegExp(`\\b${callName}\\s*\\(`, 'g');
  const records = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const prefix = text.slice(Math.max(0, match.index - 16), match.index);
    if (/function\s+$/.test(prefix)) continue;
    const assignmentPrefix = text.slice(Math.max(0, match.index - 80), match.index);
    const assignmentMatch = assignmentPrefix.match(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/);
    const argumentExpressions = readCallArguments(text, pattern.lastIndex);
    const commandExpression = argumentExpressions[0] || '';
    if (!commandExpression) continue;
    records.push({
      callId: callName,
      resultVariable: assignmentMatch ? assignmentMatch[1] : null,
      commandExpression,
      argvExpression: argumentExpressions[1] || null,
      optionsExpression: argumentExpressions[2] || null,
      argumentExpressionCount: argumentExpressions.length,
      line: text.slice(0, match.index).split('\n').length,
    });
  }
  return records;
}

function releaseFinalSettlementCommandDispatcherOk(sourceText = '') {
  const text = String(sourceText || '');
  return /function\s+commandForScript\s*\(\s*scriptId\s*\)[\s\S]*?return\s+\[\s*['"]npm['"]\s*,\s*['"]run['"]\s*,\s*scriptId\s*\]\s*;/.test(text)
    && /const\s+\[\s*command\s*,\s*\.{3}args\s*\]\s*=\s*commandForScript\s*\(\s*step\.scriptId\s*\)\s*;/.test(text)
    && /return\s+runCommand\s*\(\s*command\s*,\s*args\s*\)\s*;/.test(text);
}

function childProcessCommandExpressionAllowed(fileId, expression, sourceText = '') {
  const allowedExpressions = CHILD_PROCESS_ALLOWED_COMMAND_EXPRESSIONS_BY_FILE_ID[fileId] || [];
  if (!allowedExpressions.includes(expression)) return false;
  if (fileId === 'src/release-final-settlement.mjs' && expression === 'command') {
    return releaseFinalSettlementCommandDispatcherOk(sourceText);
  }
  return true;
}

function childProcessArgvExpressionAllowed(fileId, commandExpression, argvExpression, sourceText = '') {
  const argv = normalizeCommandExpression(argvExpression || '');
  if (!argv) return false;
  if (fileId === 'src/release-final-settlement.mjs' && commandExpression === 'command') {
    return argv === 'args' && releaseFinalSettlementCommandDispatcherOk(sourceText);
  }
  if (commandExpression === 'process.execPath') {
    if (argv === 'args') {
      return fileId === 'src/integration-dependency-gate.mjs'
        || fileId === 'src/read-only-core-gate.mjs';
    }
    return /^\[\s*['"]--check['"]\s*,\s*file\s*\]$/.test(argv)
      || /^\[\s*['"]--input-type=module['"]\s*,\s*['"]-e['"]\s*,\s*script\s*\]$/.test(argv)
      || /^\[\s*['"]src\/selftest\.mjs['"]\s*\]$/.test(argv)
      || /^\[\s*['"]src\/export-report-bootstrap-seeds\.mjs['"]\s*,\s*['"]--strict['"]\s*\]$/.test(argv);
  }
  if (commandExpression === "'npm'" || commandExpression === '"npm"') {
    return /^\[\s*['"]run['"]\s*,\s*step\.scriptId\s*\]$/.test(argv);
  }
  if (commandExpression === "'git'" || commandExpression === '"git"') {
    return /^\[\s*['"]diff['"]\s*,\s*['"]--check['"]\s*,\s*['"]--['"]\s*,\s*['"]\.['"]\s*\]$/.test(argv)
      || /^\[\s*['"]status['"]\s*,\s*['"]--short['"]\s*,\s*['"]--['"]\s*,\s*['"]\.['"]\s*\]$/.test(argv);
  }
  if (commandExpression === "'rg'" || commandExpression === '"rg"') {
    return argv.startsWith('[')
      && argv.includes("'-n'")
      && argv.includes('pattern')
      && argv.includes("'-g'")
      && argv.includes("'!src/release-final-settlement.mjs'")
      && argv.includes("'README.md'")
      && argv.includes("'docs'")
      && argv.includes("'reports/README.md'")
      && argv.includes("'src'")
      && argv.includes("'package.json'");
  }
  return false;
}

function childProcessResultHandlingAllowed(record, sourceText = '') {
  if (record.callId !== 'spawnSync') return true;
  const resultVariable = record.resultVariable || '';
  if (!resultVariable) return false;
  const escapedVariable = resultVariable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escapedVariable}\\s*\\.\\s*status\\b`).test(sourceText)
    && new RegExp(`\\b${escapedVariable}\\s*\\.\\s*error\\b`).test(sourceText)
    && new RegExp(`\\b${escapedVariable}\\s*\\.\\s*signal\\b`).test(sourceText);
}

function releaseFinalSettlementRunCommandOptionsOk(sourceText = '') {
  const text = String(sourceText || '');
  return /spawnSync\s*\(\s*command\s*,\s*args\s*,\s*\{[\s\S]*?cwd\s*:\s*packageRoot[\s\S]*?stdio\s*:\s*capture\s*\?\s*\[\s*['"]ignore['"]\s*,\s*['"]pipe['"]\s*,\s*['"]pipe['"]\s*\]\s*:\s*['"]inherit['"][\s\S]*?env\s*:\s*process\.env[\s\S]*?encoding\s*:\s*capture\s*\?\s*['"]utf8['"]\s*:\s*undefined[\s\S]*?\}\s*\)/.test(text)
    && !/spawnSync\s*\(\s*command\s*,\s*args\s*,\s*\{[\s\S]*?\bshell\s*:/.test(text);
}

function optionExpressionHasShell(expression = '') {
  return /\bshell\s*:/.test(String(expression || ''));
}

function optionExpressionHasProcessEnv(expression = '') {
  return /\benv\s*:\s*process\.env\b/.test(String(expression || ''));
}

function childProcessOptionsExpressionAllowed(fileId, record, sourceText = '') {
  const options = normalizeCommandExpression(record.optionsExpression || '');
  if (record.callId === 'runCommand') {
    if (!releaseFinalSettlementRunCommandOptionsOk(sourceText)) return false;
    if (!options) return true;
    return /^\{\s*capture\s*:\s*true\s*,?\s*\}$/.test(options);
  }
  if (record.callId !== 'spawnSync') return false;
  if (!options || !options.startsWith('{')) return false;
  if (optionExpressionHasShell(options)) return false;

  if (fileId === 'src/package-root-resolver.mjs') {
    return /\{\s*cwd\s*,/.test(options)
      && /\bencoding\s*:\s*['"]utf8['"]/.test(options)
      && /\bmaxBuffer\s*:\s*1024\s*\*\s*1024\b/.test(options)
      && !/\bstdio\s*:/.test(options)
      && !optionExpressionHasProcessEnv(options);
  }
  if (fileId === 'src/release-final-settlement.mjs') {
    return /\bcwd\s*:\s*packageRoot\b/.test(options)
      && /\bstdio\s*:\s*capture\s*\?\s*\[\s*['"]ignore['"]\s*,\s*['"]pipe['"]\s*,\s*['"]pipe['"]\s*\]\s*:\s*['"]inherit['"]/.test(options)
      && optionExpressionHasProcessEnv(options)
      && /\bencoding\s*:\s*capture\s*\?\s*['"]utf8['"]\s*:\s*undefined\b/.test(options);
  }
  if (fileId === 'src/release-full-closeout.mjs') {
    return /\bcwd\s*:\s*packageRoot\b/.test(options)
      && /\bstdio\s*:\s*['"]inherit['"]/.test(options)
      && optionExpressionHasProcessEnv(options);
  }
  return /\bcwd\s*:\s*packageRoot\b/.test(options)
    && /\bencoding\s*:\s*['"]utf8['"]/.test(options)
    && /\bmaxBuffer\s*:\s*(?:(?:10|20)\s*\*\s*1024\s*\*\s*1024|1024\s*\*\s*1024)\b/.test(options)
    && !/\bstdio\s*:/.test(options)
    && !optionExpressionHasProcessEnv(options);
}

function childProcessCommandRecordsFor(fileId, sourceText = '') {
  const directRecords = extractCallFirstArgumentRecords(sourceText, 'spawnSync');
  const delegatedRecords = fileId === 'src/release-final-settlement.mjs'
    ? extractCallFirstArgumentRecords(sourceText, 'runCommand')
    : [];
  return [...directRecords, ...delegatedRecords].map((record) => {
    const commandExpression = normalizeCommandExpression(record.commandExpression);
    const commandApproved = childProcessCommandExpressionAllowed(fileId, commandExpression, sourceText);
    const argvExpression = normalizeCommandExpression(record.argvExpression || '');
    const argvApproved = commandApproved === true
      && childProcessArgvExpressionAllowed(fileId, commandExpression, argvExpression, sourceText);
    const optionsExpression = normalizeCommandExpression(record.optionsExpression || '');
    const optionsApproved = commandApproved === true
      && argvApproved === true
      && childProcessOptionsExpressionAllowed(fileId, { ...record, optionsExpression }, sourceText);
    const resultHandlingApproved = commandApproved === true
      && argvApproved === true
      && optionsApproved === true
      && childProcessResultHandlingAllowed(record, sourceText);
    return {
      ...record,
      commandExpression,
      argvExpression,
      optionsExpression,
      commandApproved,
      argvApproved,
      optionsApproved,
      resultHandlingApproved,
      commandDispatcherOk: commandExpression === 'command'
        ? releaseFinalSettlementCommandDispatcherOk(sourceText)
        : null,
      runCommandOptionsOk: record.callId === 'runCommand'
        ? releaseFinalSettlementRunCommandOptionsOk(sourceText)
        : null,
    };
  });
}

function analyzeChildProcessPolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => {
      const childProcessCommandRecords = childProcessCommandRecordsFor(fileId, sourceText);
      const disallowedChildProcessCommandRecords = childProcessCommandRecords
        .filter((record) => record.commandApproved !== true);
      const disallowedChildProcessArgvRecords = childProcessCommandRecords
        .filter((record) => record.commandApproved === true && record.argvApproved !== true);
      const disallowedChildProcessOptionsRecords = childProcessCommandRecords
        .filter((record) => (
          record.commandApproved === true
          && record.argvApproved === true
          && record.optionsApproved !== true
        ));
      const disallowedChildProcessResultRecords = childProcessCommandRecords
        .filter((record) => (
          record.callId === 'spawnSync'
          && record.commandApproved === true
          && record.argvApproved === true
          && record.optionsApproved === true
          && record.resultHandlingApproved !== true
        ));
      return {
        fileId,
        allowed: CHILD_PROCESS_ALLOWED_FILE_IDS.includes(fileId),
        childProcessPatternIds: childProcessPatternIds(sourceText),
        childProcessCommandRecords,
        approvedChildProcessCommandCount: childProcessCommandRecords
          .filter((record) => record.commandApproved === true).length,
        disallowedChildProcessCommandRecords,
        approvedChildProcessArgvCount: childProcessCommandRecords
          .filter((record) => record.argvApproved === true).length,
        disallowedChildProcessArgvRecords,
        approvedChildProcessOptionsCount: childProcessCommandRecords
          .filter((record) => record.optionsApproved === true).length,
        disallowedChildProcessOptionsRecords,
        childProcessSpawnCount: childProcessCommandRecords
          .filter((record) => record.callId === 'spawnSync').length,
        approvedChildProcessResultCount: childProcessCommandRecords
          .filter((record) => record.callId === 'spawnSync' && record.resultHandlingApproved === true).length,
        disallowedChildProcessResultRecords,
      };
    })
    .filter((record) => record.childProcessPatternIds.length > 0);
  const blockers = records
    .filter((record) => !record.allowed)
    .map((record) => blocker(
      'report_contract_syntax_coverage_child_process_outside_allowlist',
      `${record.fileId} must not import node:child_process or execute child processes outside local orchestration allowlist files.`,
      { fileId: record.fileId, childProcessPatternIds: record.childProcessPatternIds },
    ))
    .concat(records
      .filter((record) => record.allowed && record.disallowedChildProcessCommandRecords.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_child_process_command_not_approved',
        `${record.fileId} must only spawn approved local command operands: process.execPath, npm run, rg, or git local probes.`,
        {
          fileId: record.fileId,
          disallowedChildProcessCommandExpressions: record.disallowedChildProcessCommandRecords
            .map((item) => item.commandExpression),
          disallowedChildProcessCommandRecords: record.disallowedChildProcessCommandRecords,
        },
      )));
  const argvBlockers = records
    .filter((record) => record.allowed && record.disallowedChildProcessArgvRecords.length > 0)
    .map((record) => blocker(
      'report_contract_syntax_coverage_child_process_argv_not_approved',
      `${record.fileId} must only spawn approved local argv vectors for process.execPath, npm run, rg, or git diff/status probes.`,
      {
        fileId: record.fileId,
        disallowedChildProcessArgvExpressions: record.disallowedChildProcessArgvRecords
          .map((item) => item.argvExpression),
        disallowedChildProcessArgvRecords: record.disallowedChildProcessArgvRecords,
      },
    ));
  const optionsBlockers = records
    .filter((record) => record.allowed && record.disallowedChildProcessOptionsRecords.length > 0)
    .map((record) => blocker(
      'report_contract_syntax_coverage_child_process_options_not_approved',
      `${record.fileId} must only spawn with approved local cwd/env/stdio options and must not enable shell execution.`,
      {
        fileId: record.fileId,
        disallowedChildProcessOptionsExpressions: record.disallowedChildProcessOptionsRecords
          .map((item) => item.optionsExpression),
        disallowedChildProcessOptionsRecords: record.disallowedChildProcessOptionsRecords,
      },
    ));
  const resultBlockers = records
    .filter((record) => record.allowed && record.disallowedChildProcessResultRecords.length > 0)
    .map((record) => blocker(
      'report_contract_syntax_coverage_child_process_result_not_validated',
      `${record.fileId} must bind each direct spawn result to status, error, and signal handling.`,
      {
        fileId: record.fileId,
        disallowedChildProcessResultRecords: record.disallowedChildProcessResultRecords,
      },
    ));
  return {
    status: blockers.length || argvBlockers.length || optionsBlockers.length || resultBlockers.length
      ? 'blocked_report_contract_child_process_policy'
      : 'pass_report_contract_child_process_policy',
    ok: blockers.length === 0
      && argvBlockers.length === 0
      && optionsBlockers.length === 0
      && resultBlockers.length === 0,
    childProcessSourceCount: records.length,
    allowedChildProcessSourceCount: records.filter((record) => record.allowed).length,
    disallowedChildProcessSourceCount: records.filter((record) => !record.allowed).length,
    childProcessCommandSourceCount: records.filter((record) => record.childProcessCommandRecords.length > 0).length,
    childProcessCommandCount: records.reduce((sum, record) => sum + record.childProcessCommandRecords.length, 0),
    approvedChildProcessCommandCount: records.reduce((sum, record) => sum + record.approvedChildProcessCommandCount, 0),
    disallowedChildProcessCommandCount: records.reduce((sum, record) => (
      sum + record.disallowedChildProcessCommandRecords.length
    ), 0),
    approvedChildProcessArgvCount: records.reduce((sum, record) => sum + record.approvedChildProcessArgvCount, 0),
    disallowedChildProcessArgvCount: records.reduce((sum, record) => (
      sum + record.disallowedChildProcessArgvRecords.length
    ), 0),
    approvedChildProcessOptionsCount: records.reduce((sum, record) => (
      sum + record.approvedChildProcessOptionsCount
    ), 0),
    disallowedChildProcessOptionsCount: records.reduce((sum, record) => (
      sum + record.disallowedChildProcessOptionsRecords.length
    ), 0),
    childProcessSpawnCount: records.reduce((sum, record) => sum + record.childProcessSpawnCount, 0),
    approvedChildProcessResultCount: records.reduce((sum, record) => (
      sum + record.approvedChildProcessResultCount
    ), 0),
    disallowedChildProcessResultCount: records.reduce((sum, record) => (
      sum + record.disallowedChildProcessResultRecords.length
    ), 0),
    childProcessSources: records,
    blockers: [...blockers, ...argvBlockers, ...optionsBlockers, ...resultBlockers],
  };
}

function patternIdsFor(patterns = [], sourceText = '') {
  return patterns
    .map(({ patternId, pattern }) => (pattern.test(String(sourceText || '')) ? patternId : null))
    .filter(Boolean);
}

function analyzeExternalBoundaryPolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => {
      const networkApiPatternIds = patternIdsFor(NETWORK_API_PATTERNS, sourceText);
      const browserAutomationPatternIds = patternIdsFor(BROWSER_AUTOMATION_PATTERNS, sourceText);
      const processEnvPatternIds = patternIdsFor(PROCESS_ENV_PATTERNS, sourceText);
      const processEnvAllowed = processEnvPatternIds.length === 0
        || EXTERNAL_BOUNDARY_PROCESS_ENV_ALLOWED_FILE_IDS.includes(fileId);
      return {
        fileId,
        networkApiPatternIds,
        browserAutomationPatternIds,
        processEnvPatternIds,
        processEnvAllowed,
        allowed: networkApiPatternIds.length === 0
          && browserAutomationPatternIds.length === 0
          && processEnvAllowed,
      };
    })
    .filter((record) => (
      record.networkApiPatternIds.length > 0
      || record.browserAutomationPatternIds.length > 0
      || record.processEnvPatternIds.length > 0
    ));
  const blockers = [
    ...records
      .filter((record) => record.networkApiPatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_network_api_detected',
        `${record.fileId} must not import or call network APIs from local report/contract sources.`,
        { fileId: record.fileId, networkApiPatternIds: record.networkApiPatternIds },
      )),
    ...records
      .filter((record) => record.browserAutomationPatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_browser_automation_detected',
        `${record.fileId} must not import browser automation packages from local report/contract sources.`,
        { fileId: record.fileId, browserAutomationPatternIds: record.browserAutomationPatternIds },
      )),
    ...records
      .filter((record) => record.processEnvPatternIds.length > 0 && !record.processEnvAllowed)
      .map((record) => blocker(
        'report_contract_syntax_coverage_process_env_outside_allowlist',
        `${record.fileId} must not pass or read inherited process env outside release orchestration allowlist files.`,
        { fileId: record.fileId, processEnvPatternIds: record.processEnvPatternIds },
      )),
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_external_boundary_policy' : 'pass_report_contract_external_boundary_policy',
    ok: blockers.length === 0,
    externalBoundarySourceCount: records.length,
    networkApiSourceCount: records.filter((record) => record.networkApiPatternIds.length > 0).length,
    browserAutomationSourceCount: records.filter((record) => record.browserAutomationPatternIds.length > 0).length,
    processEnvSourceCount: records.filter((record) => record.processEnvPatternIds.length > 0).length,
    allowedProcessEnvSourceCount: records.filter((record) => (
      record.processEnvPatternIds.length > 0 && record.processEnvAllowed
    )).length,
    disallowedProcessEnvSourceCount: records.filter((record) => (
      record.processEnvPatternIds.length > 0 && !record.processEnvAllowed
    )).length,
    externalBoundarySources: records,
    blockers,
  };
}

function analyzeDynamicCodePolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => {
      const dynamicImportPatternIds = patternIdsFor(DYNAMIC_IMPORT_PATTERNS, sourceText);
      const unsafeDynamicCodePatternIds = patternIdsFor(UNSAFE_DYNAMIC_CODE_PATTERNS, sourceText);
      const dynamicImportAllowed = dynamicImportPatternIds.length === 0
        || DYNAMIC_IMPORT_ALLOWED_FILE_IDS.includes(fileId);
      return {
        fileId,
        dynamicImportPatternIds,
        unsafeDynamicCodePatternIds,
        dynamicImportAllowed,
        allowed: dynamicImportAllowed && unsafeDynamicCodePatternIds.length === 0,
      };
    })
    .filter((record) => (
      record.dynamicImportPatternIds.length > 0
      || record.unsafeDynamicCodePatternIds.length > 0
    ));
  const blockers = [
    ...records
      .filter((record) => record.dynamicImportPatternIds.length > 0 && !record.dynamicImportAllowed)
      .map((record) => blocker(
        'report_contract_syntax_coverage_dynamic_import_outside_allowlist',
        `${record.fileId} must not use dynamic import outside local package-surface and package-root resolver checks.`,
        { fileId: record.fileId, dynamicImportPatternIds: record.dynamicImportPatternIds },
      )),
    ...records
      .filter((record) => record.unsafeDynamicCodePatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_unsafe_dynamic_code_detected',
        `${record.fileId} must not use eval, Function constructors, or node vm runtime code execution.`,
        { fileId: record.fileId, unsafeDynamicCodePatternIds: record.unsafeDynamicCodePatternIds },
      )),
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_dynamic_code_policy' : 'pass_report_contract_dynamic_code_policy',
    ok: blockers.length === 0,
    dynamicCodeSourceCount: records.length,
    dynamicImportSourceCount: records.filter((record) => record.dynamicImportPatternIds.length > 0).length,
    allowedDynamicImportSourceCount: records.filter((record) => (
      record.dynamicImportPatternIds.length > 0 && record.dynamicImportAllowed
    )).length,
    disallowedDynamicImportSourceCount: records.filter((record) => (
      record.dynamicImportPatternIds.length > 0 && !record.dynamicImportAllowed
    )).length,
    unsafeDynamicCodeSourceCount: records.filter((record) => record.unsafeDynamicCodePatternIds.length > 0).length,
    dynamicCodeSources: records,
    blockers,
  };
}

function analyzeRandomnessCryptoPolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => {
      const cryptoPatternIds = patternIdsFor(CRYPTO_PATTERNS, sourceText);
      const randomnessPatternIds = patternIdsFor(RANDOMNESS_PATTERNS, sourceText);
      const cryptoAllowed = cryptoPatternIds.length === 0 || CRYPTO_ALLOWED_FILE_IDS.includes(fileId);
      return {
        fileId,
        cryptoPatternIds,
        randomnessPatternIds,
        cryptoAllowed,
        allowed: cryptoAllowed && randomnessPatternIds.length === 0,
      };
    })
    .filter((record) => record.cryptoPatternIds.length > 0 || record.randomnessPatternIds.length > 0);
  const blockers = [
    ...records
      .filter((record) => record.cryptoPatternIds.length > 0 && !record.cryptoAllowed)
      .map((record) => blocker(
        'report_contract_syntax_coverage_crypto_outside_allowlist',
        `${record.fileId} must not import crypto outside deterministic hashing allowlist files.`,
        { fileId: record.fileId, cryptoPatternIds: record.cryptoPatternIds },
      )),
    ...records
      .filter((record) => record.randomnessPatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_randomness_detected',
        `${record.fileId} must not use runtime randomness in local report/contract sources.`,
        { fileId: record.fileId, randomnessPatternIds: record.randomnessPatternIds },
      )),
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_randomness_crypto_policy' : 'pass_report_contract_randomness_crypto_policy',
    ok: blockers.length === 0,
    randomnessCryptoSourceCount: records.length,
    cryptoSourceCount: records.filter((record) => record.cryptoPatternIds.length > 0).length,
    allowedCryptoSourceCount: records.filter((record) => (
      record.cryptoPatternIds.length > 0 && record.cryptoAllowed
    )).length,
    disallowedCryptoSourceCount: records.filter((record) => (
      record.cryptoPatternIds.length > 0 && !record.cryptoAllowed
    )).length,
    randomnessSourceCount: records.filter((record) => record.randomnessPatternIds.length > 0).length,
    randomnessCryptoSources: records,
    blockers,
  };
}

function analyzeRuntimeSideEffectPolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => {
      const directProcessExitPatternIds = patternIdsFor(DIRECT_PROCESS_EXIT_PATTERNS, sourceText);
      const processEnvMutationPatternIds = patternIdsFor(PROCESS_ENV_MUTATION_PATTERNS, sourceText);
      const asyncTimerPatternIds = patternIdsFor(ASYNC_TIMER_PATTERNS, sourceText);
      const directProcessExitAllowed = directProcessExitPatternIds.length === 0
        || DIRECT_PROCESS_EXIT_ALLOWED_FILE_IDS.includes(fileId);
      return {
        fileId,
        directProcessExitPatternIds,
        processEnvMutationPatternIds,
        asyncTimerPatternIds,
        directProcessExitAllowed,
        allowed: directProcessExitAllowed
          && processEnvMutationPatternIds.length === 0
          && asyncTimerPatternIds.length === 0,
      };
    })
    .filter((record) => (
      record.directProcessExitPatternIds.length > 0
      || record.processEnvMutationPatternIds.length > 0
      || record.asyncTimerPatternIds.length > 0
    ));
  const blockers = [
    ...records
      .filter((record) => record.directProcessExitPatternIds.length > 0 && !record.directProcessExitAllowed)
      .map((record) => blocker(
        'report_contract_syntax_coverage_direct_process_exit_outside_allowlist',
        `${record.fileId} must not terminate the process outside approved local orchestration allowlist files.`,
        { fileId: record.fileId, directProcessExitPatternIds: record.directProcessExitPatternIds },
      )),
    ...records
      .filter((record) => record.processEnvMutationPatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_process_env_mutation_detected',
        `${record.fileId} must not mutate inherited process environment.`,
        { fileId: record.fileId, processEnvMutationPatternIds: record.processEnvMutationPatternIds },
      )),
    ...records
      .filter((record) => record.asyncTimerPatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_async_timer_detected',
        `${record.fileId} must not schedule timers, immediates, next ticks, or microtasks in local report/contract sources.`,
        { fileId: record.fileId, asyncTimerPatternIds: record.asyncTimerPatternIds },
      )),
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_runtime_side_effect_policy' : 'pass_report_contract_runtime_side_effect_policy',
    ok: blockers.length === 0,
    runtimeSideEffectSourceCount: records.length,
    directProcessExitSourceCount: records.filter((record) => record.directProcessExitPatternIds.length > 0).length,
    allowedDirectProcessExitSourceCount: records.filter((record) => (
      record.directProcessExitPatternIds.length > 0 && record.directProcessExitAllowed
    )).length,
    disallowedDirectProcessExitSourceCount: records.filter((record) => (
      record.directProcessExitPatternIds.length > 0 && !record.directProcessExitAllowed
    )).length,
    processEnvMutationSourceCount: records.filter((record) => record.processEnvMutationPatternIds.length > 0).length,
    asyncTimerSourceCount: records.filter((record) => record.asyncTimerPatternIds.length > 0).length,
    runtimeSideEffectSources: records,
    blockers,
  };
}

function analyzeCommandStringPolicy(input = {}) {
  const records = Object.entries(input.sourceTextsByFileId || {})
    .filter(([fileId]) => String(fileId || '').endsWith('.mjs'))
    .map(([fileId, sourceText]) => {
      const destructiveCommandStringPatternIds = patternIdsFor(DESTRUCTIVE_COMMAND_STRING_PATTERNS, sourceText);
      const externalCommandStringPatternIds = patternIdsFor(EXTERNAL_COMMAND_STRING_PATTERNS, sourceText);
      return {
        fileId,
        destructiveCommandStringPatternIds,
        externalCommandStringPatternIds,
        allowed: destructiveCommandStringPatternIds.length === 0
          && externalCommandStringPatternIds.length === 0,
      };
    })
    .filter((record) => (
      record.destructiveCommandStringPatternIds.length > 0
      || record.externalCommandStringPatternIds.length > 0
    ));
  const blockers = [
    ...records
      .filter((record) => record.destructiveCommandStringPatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_destructive_command_string_detected',
        `${record.fileId} must not contain destructive shell command strings.`,
        { fileId: record.fileId, destructiveCommandStringPatternIds: record.destructiveCommandStringPatternIds },
      )),
    ...records
      .filter((record) => record.externalCommandStringPatternIds.length > 0)
      .map((record) => blocker(
        'report_contract_syntax_coverage_external_command_string_detected',
        `${record.fileId} must not contain remote shell or external network command strings.`,
        { fileId: record.fileId, externalCommandStringPatternIds: record.externalCommandStringPatternIds },
      )),
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_command_string_policy' : 'pass_report_contract_command_string_policy',
    ok: blockers.length === 0,
    commandStringSourceCount: records.length,
    destructiveCommandStringSourceCount: records.filter((record) => record.destructiveCommandStringPatternIds.length > 0).length,
    externalCommandStringSourceCount: records.filter((record) => record.externalCommandStringPatternIds.length > 0).length,
    commandStringSources: records,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    status: contract.status,
    ok: contract.ok === true,
    sourcePath: contract.sourcePath,
    exporterPath: contract.exporterPath,
    sourceSyntaxStepId: contract.sourceSyntaxStepId,
    exporterSyntaxStepId: contract.exporterSyntaxStepId,
    stepIds: contract.stepIds,
    sourceFileExists: contract.sourceFileExists === true,
    exporterFileExists: contract.exporterFileExists === true,
    sourceSyntaxStepPresent: contract.sourceSyntaxStepPresent === true,
    exporterSyntaxStepPresent: contract.exporterSyntaxStepPresent === true,
    sourceSyntaxArgPresent: contract.sourceSyntaxArgPresent === true,
    exporterSyntaxArgPresent: contract.exporterSyntaxArgPresent === true,
    sourceBeforeExporter: contract.sourceBeforeExporter === true,
    exportStepCount: contract.exportStepCount || 0,
    presentExportStepCount: contract.presentExportStepCount || 0,
    exporterBeforeExportCount: contract.exporterBeforeExportCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      stepId: item.stepId || null,
      previousStepId: item.previousStepId || null,
      fileId: item.fileId || null,
    })),
  };
}

function analyzeSyntaxCoverage(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract);
  const contractAnalyses = contracts.map((contract) => analyzeContract(contract, input));
  const cliEntrypointPolicy = analyzeCliEntrypointPolicy(input);
  const urlPathnamePolicy = analyzeUrlPathnamePolicy(input);
  const directWritePolicy = analyzeDirectWritePolicy(input);
  const filesystemMutationPolicy = analyzeFilesystemMutationPolicy(input);
  const childProcessPolicy = analyzeChildProcessPolicy(input);
  const externalBoundaryPolicy = analyzeExternalBoundaryPolicy(input);
  const dynamicCodePolicy = analyzeDynamicCodePolicy(input);
  const randomnessCryptoPolicy = analyzeRandomnessCryptoPolicy(input);
  const runtimeSideEffectPolicy = analyzeRuntimeSideEffectPolicy(input);
  const commandStringPolicy = analyzeCommandStringPolicy(input);
  const blockers = [
    ...contractAnalyses.flatMap((contract) => contract.blockers),
    ...cliEntrypointPolicy.blockers,
    ...urlPathnamePolicy.blockers,
    ...directWritePolicy.blockers,
    ...filesystemMutationPolicy.blockers,
    ...childProcessPolicy.blockers,
    ...externalBoundaryPolicy.blockers,
    ...dynamicCodePolicy.blockers,
    ...randomnessCryptoPolicy.blockers,
    ...runtimeSideEffectPolicy.blockers,
    ...commandStringPolicy.blockers,
  ];
  return {
    status: blockers.length ? 'blocked_report_contract_syntax_coverage_analysis' : 'pass_report_contract_syntax_coverage_analysis',
    ok: blockers.length === 0,
    contractCount: contractAnalyses.length,
    okContractCount: contractAnalyses.filter((contract) => contract.ok).length,
    sourceFileCount: contractAnalyses.filter((contract) => contract.sourceFileExists).length,
    exporterFileCount: contractAnalyses.filter((contract) => contract.exporterFileExists).length,
    sourceSyntaxStepCount: contractAnalyses.filter((contract) => contract.sourceSyntaxStepPresent).length,
    exporterSyntaxStepCount: contractAnalyses.filter((contract) => contract.exporterSyntaxStepPresent).length,
    sourceSyntaxArgCount: contractAnalyses.filter((contract) => contract.sourceSyntaxArgPresent).length,
    exporterSyntaxArgCount: contractAnalyses.filter((contract) => contract.exporterSyntaxArgPresent).length,
    sourceBeforeExporterCount: contractAnalyses.filter((contract) => contract.sourceBeforeExporter).length,
    exportStepCount: contractAnalyses.reduce((sum, contract) => sum + contract.exportStepCount, 0),
    presentExportStepCount: contractAnalyses.reduce((sum, contract) => sum + contract.presentExportStepCount, 0),
    exporterBeforeExportCount: contractAnalyses.reduce((sum, contract) => sum + contract.exporterBeforeExportCount, 0),
    cliEntrypointPolicyOk: cliEntrypointPolicy.ok === true,
    cliEntrypointSourceCount: cliEntrypointPolicy.cliEntrypointSourceCount,
    cliEntrypointHelperCount: cliEntrypointPolicy.cliEntrypointHelperCount,
    rawCliEntrypointCount: cliEntrypointPolicy.rawCliEntrypointCount,
    cliEntrypointSources: cliEntrypointPolicy.cliEntrypointSources,
    urlPathnamePolicyOk: urlPathnamePolicy.ok === true,
    urlPathnameSourceCount: urlPathnamePolicy.urlPathnameSourceCount,
    urlPathnameSources: urlPathnamePolicy.urlPathnameSources,
    directWritePolicyOk: directWritePolicy.ok === true,
    directWriteSourceCount: directWritePolicy.directWriteSourceCount,
    allowedDirectWriteSourceCount: directWritePolicy.allowedDirectWriteSourceCount,
    disallowedDirectWriteSourceCount: directWritePolicy.disallowedDirectWriteSourceCount,
    directWriteSources: directWritePolicy.directWriteSources,
    filesystemMutationPolicyOk: filesystemMutationPolicy.ok === true,
    filesystemMutationSourceCount: filesystemMutationPolicy.filesystemMutationSourceCount,
    allowedFilesystemMutationSourceCount: filesystemMutationPolicy.allowedFilesystemMutationSourceCount,
    disallowedFilesystemMutationSourceCount: filesystemMutationPolicy.disallowedFilesystemMutationSourceCount,
    filesystemMutationSources: filesystemMutationPolicy.filesystemMutationSources,
    childProcessPolicyOk: childProcessPolicy.ok === true,
    childProcessSourceCount: childProcessPolicy.childProcessSourceCount,
    allowedChildProcessSourceCount: childProcessPolicy.allowedChildProcessSourceCount,
    disallowedChildProcessSourceCount: childProcessPolicy.disallowedChildProcessSourceCount,
    childProcessCommandSourceCount: childProcessPolicy.childProcessCommandSourceCount,
    childProcessCommandCount: childProcessPolicy.childProcessCommandCount,
    approvedChildProcessCommandCount: childProcessPolicy.approvedChildProcessCommandCount,
    disallowedChildProcessCommandCount: childProcessPolicy.disallowedChildProcessCommandCount,
    approvedChildProcessArgvCount: childProcessPolicy.approvedChildProcessArgvCount,
    disallowedChildProcessArgvCount: childProcessPolicy.disallowedChildProcessArgvCount,
    approvedChildProcessOptionsCount: childProcessPolicy.approvedChildProcessOptionsCount,
    disallowedChildProcessOptionsCount: childProcessPolicy.disallowedChildProcessOptionsCount,
    childProcessSpawnCount: childProcessPolicy.childProcessSpawnCount,
    approvedChildProcessResultCount: childProcessPolicy.approvedChildProcessResultCount,
    disallowedChildProcessResultCount: childProcessPolicy.disallowedChildProcessResultCount,
    childProcessSources: childProcessPolicy.childProcessSources,
    externalBoundaryPolicyOk: externalBoundaryPolicy.ok === true,
    externalBoundarySourceCount: externalBoundaryPolicy.externalBoundarySourceCount,
    networkApiSourceCount: externalBoundaryPolicy.networkApiSourceCount,
    browserAutomationSourceCount: externalBoundaryPolicy.browserAutomationSourceCount,
    processEnvSourceCount: externalBoundaryPolicy.processEnvSourceCount,
    allowedProcessEnvSourceCount: externalBoundaryPolicy.allowedProcessEnvSourceCount,
    disallowedProcessEnvSourceCount: externalBoundaryPolicy.disallowedProcessEnvSourceCount,
    externalBoundarySources: externalBoundaryPolicy.externalBoundarySources,
    dynamicCodePolicyOk: dynamicCodePolicy.ok === true,
    dynamicCodeSourceCount: dynamicCodePolicy.dynamicCodeSourceCount,
    dynamicImportSourceCount: dynamicCodePolicy.dynamicImportSourceCount,
    allowedDynamicImportSourceCount: dynamicCodePolicy.allowedDynamicImportSourceCount,
    disallowedDynamicImportSourceCount: dynamicCodePolicy.disallowedDynamicImportSourceCount,
    unsafeDynamicCodeSourceCount: dynamicCodePolicy.unsafeDynamicCodeSourceCount,
    dynamicCodeSources: dynamicCodePolicy.dynamicCodeSources,
    randomnessCryptoPolicyOk: randomnessCryptoPolicy.ok === true,
    randomnessCryptoSourceCount: randomnessCryptoPolicy.randomnessCryptoSourceCount,
    cryptoSourceCount: randomnessCryptoPolicy.cryptoSourceCount,
    allowedCryptoSourceCount: randomnessCryptoPolicy.allowedCryptoSourceCount,
    disallowedCryptoSourceCount: randomnessCryptoPolicy.disallowedCryptoSourceCount,
    randomnessSourceCount: randomnessCryptoPolicy.randomnessSourceCount,
    randomnessCryptoSources: randomnessCryptoPolicy.randomnessCryptoSources,
    runtimeSideEffectPolicyOk: runtimeSideEffectPolicy.ok === true,
    runtimeSideEffectSourceCount: runtimeSideEffectPolicy.runtimeSideEffectSourceCount,
    directProcessExitSourceCount: runtimeSideEffectPolicy.directProcessExitSourceCount,
    allowedDirectProcessExitSourceCount: runtimeSideEffectPolicy.allowedDirectProcessExitSourceCount,
    disallowedDirectProcessExitSourceCount: runtimeSideEffectPolicy.disallowedDirectProcessExitSourceCount,
    processEnvMutationSourceCount: runtimeSideEffectPolicy.processEnvMutationSourceCount,
    asyncTimerSourceCount: runtimeSideEffectPolicy.asyncTimerSourceCount,
    runtimeSideEffectSources: runtimeSideEffectPolicy.runtimeSideEffectSources,
    commandStringPolicyOk: commandStringPolicy.ok === true,
    commandStringSourceCount: commandStringPolicy.commandStringSourceCount,
    destructiveCommandStringSourceCount: commandStringPolicy.destructiveCommandStringSourceCount,
    externalCommandStringSourceCount: commandStringPolicy.externalCommandStringSourceCount,
    commandStringSources: commandStringPolicy.commandStringSources,
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
    sourceFileCount: analysis.sourceFileCount || 0,
    exporterFileCount: analysis.exporterFileCount || 0,
    sourceSyntaxStepCount: analysis.sourceSyntaxStepCount || 0,
    exporterSyntaxStepCount: analysis.exporterSyntaxStepCount || 0,
    sourceSyntaxArgCount: analysis.sourceSyntaxArgCount || 0,
    exporterSyntaxArgCount: analysis.exporterSyntaxArgCount || 0,
    sourceBeforeExporterCount: analysis.sourceBeforeExporterCount || 0,
    exportStepCount: analysis.exportStepCount || 0,
    presentExportStepCount: analysis.presentExportStepCount || 0,
    exporterBeforeExportCount: analysis.exporterBeforeExportCount || 0,
    cliEntrypointPolicyOk: analysis.cliEntrypointPolicyOk === true,
    cliEntrypointSourceCount: analysis.cliEntrypointSourceCount || 0,
    cliEntrypointHelperCount: analysis.cliEntrypointHelperCount || 0,
    rawCliEntrypointCount: analysis.rawCliEntrypointCount || 0,
    urlPathnamePolicyOk: analysis.urlPathnamePolicyOk === true,
    urlPathnameSourceCount: analysis.urlPathnameSourceCount || 0,
    directWritePolicyOk: analysis.directWritePolicyOk === true,
    directWriteSourceCount: analysis.directWriteSourceCount || 0,
    allowedDirectWriteSourceCount: analysis.allowedDirectWriteSourceCount || 0,
    disallowedDirectWriteSourceCount: analysis.disallowedDirectWriteSourceCount || 0,
    filesystemMutationPolicyOk: analysis.filesystemMutationPolicyOk === true,
    filesystemMutationSourceCount: analysis.filesystemMutationSourceCount || 0,
    allowedFilesystemMutationSourceCount: analysis.allowedFilesystemMutationSourceCount || 0,
    disallowedFilesystemMutationSourceCount: analysis.disallowedFilesystemMutationSourceCount || 0,
    childProcessPolicyOk: analysis.childProcessPolicyOk === true,
    childProcessSourceCount: analysis.childProcessSourceCount || 0,
    allowedChildProcessSourceCount: analysis.allowedChildProcessSourceCount || 0,
    disallowedChildProcessSourceCount: analysis.disallowedChildProcessSourceCount || 0,
    childProcessCommandSourceCount: analysis.childProcessCommandSourceCount || 0,
    childProcessCommandCount: analysis.childProcessCommandCount || 0,
    approvedChildProcessCommandCount: analysis.approvedChildProcessCommandCount || 0,
    disallowedChildProcessCommandCount: analysis.disallowedChildProcessCommandCount || 0,
    approvedChildProcessArgvCount: analysis.approvedChildProcessArgvCount || 0,
    disallowedChildProcessArgvCount: analysis.disallowedChildProcessArgvCount || 0,
    approvedChildProcessOptionsCount: analysis.approvedChildProcessOptionsCount || 0,
    disallowedChildProcessOptionsCount: analysis.disallowedChildProcessOptionsCount || 0,
    childProcessSpawnCount: analysis.childProcessSpawnCount || 0,
    approvedChildProcessResultCount: analysis.approvedChildProcessResultCount || 0,
    disallowedChildProcessResultCount: analysis.disallowedChildProcessResultCount || 0,
    externalBoundaryPolicyOk: analysis.externalBoundaryPolicyOk === true,
    externalBoundarySourceCount: analysis.externalBoundarySourceCount || 0,
    networkApiSourceCount: analysis.networkApiSourceCount || 0,
    browserAutomationSourceCount: analysis.browserAutomationSourceCount || 0,
    processEnvSourceCount: analysis.processEnvSourceCount || 0,
    allowedProcessEnvSourceCount: analysis.allowedProcessEnvSourceCount || 0,
    disallowedProcessEnvSourceCount: analysis.disallowedProcessEnvSourceCount || 0,
    dynamicCodePolicyOk: analysis.dynamicCodePolicyOk === true,
    dynamicCodeSourceCount: analysis.dynamicCodeSourceCount || 0,
    dynamicImportSourceCount: analysis.dynamicImportSourceCount || 0,
    allowedDynamicImportSourceCount: analysis.allowedDynamicImportSourceCount || 0,
    disallowedDynamicImportSourceCount: analysis.disallowedDynamicImportSourceCount || 0,
    unsafeDynamicCodeSourceCount: analysis.unsafeDynamicCodeSourceCount || 0,
    randomnessCryptoPolicyOk: analysis.randomnessCryptoPolicyOk === true,
    randomnessCryptoSourceCount: analysis.randomnessCryptoSourceCount || 0,
    cryptoSourceCount: analysis.cryptoSourceCount || 0,
    allowedCryptoSourceCount: analysis.allowedCryptoSourceCount || 0,
    disallowedCryptoSourceCount: analysis.disallowedCryptoSourceCount || 0,
    randomnessSourceCount: analysis.randomnessSourceCount || 0,
    runtimeSideEffectPolicyOk: analysis.runtimeSideEffectPolicyOk === true,
    runtimeSideEffectSourceCount: analysis.runtimeSideEffectSourceCount || 0,
    directProcessExitSourceCount: analysis.directProcessExitSourceCount || 0,
    allowedDirectProcessExitSourceCount: analysis.allowedDirectProcessExitSourceCount || 0,
    disallowedDirectProcessExitSourceCount: analysis.disallowedDirectProcessExitSourceCount || 0,
    processEnvMutationSourceCount: analysis.processEnvMutationSourceCount || 0,
    asyncTimerSourceCount: analysis.asyncTimerSourceCount || 0,
    commandStringPolicyOk: analysis.commandStringPolicyOk === true,
    commandStringSourceCount: analysis.commandStringSourceCount || 0,
    destructiveCommandStringSourceCount: analysis.destructiveCommandStringSourceCount || 0,
    externalCommandStringSourceCount: analysis.externalCommandStringSourceCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      stepId: item.stepId || null,
      previousStepId: item.previousStepId || null,
      fileId: item.fileId || null,
      rawPatternIds: item.rawPatternIds || [],
      operationIds: item.operationIds || [],
      disallowedOperationIds: item.disallowedOperationIds || [],
      childProcessPatternIds: item.childProcessPatternIds || [],
      disallowedChildProcessCommandExpressions: item.disallowedChildProcessCommandExpressions || [],
      disallowedChildProcessArgvExpressions: item.disallowedChildProcessArgvExpressions || [],
      disallowedChildProcessOptionsExpressions: item.disallowedChildProcessOptionsExpressions || [],
      disallowedChildProcessResultRecords: item.disallowedChildProcessResultRecords || [],
      networkApiPatternIds: item.networkApiPatternIds || [],
      browserAutomationPatternIds: item.browserAutomationPatternIds || [],
      processEnvPatternIds: item.processEnvPatternIds || [],
      dynamicImportPatternIds: item.dynamicImportPatternIds || [],
      unsafeDynamicCodePatternIds: item.unsafeDynamicCodePatternIds || [],
      cryptoPatternIds: item.cryptoPatternIds || [],
      randomnessPatternIds: item.randomnessPatternIds || [],
      directProcessExitPatternIds: item.directProcessExitPatternIds || [],
      processEnvMutationPatternIds: item.processEnvMutationPatternIds || [],
      asyncTimerPatternIds: item.asyncTimerPatternIds || [],
      destructiveCommandStringPatternIds: item.destructiveCommandStringPatternIds || [],
      externalCommandStringPatternIds: item.externalCommandStringPatternIds || [],
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeSyntaxCoverage(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_syntax_coverage_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract syntax coverage analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_syntax_coverage_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_syntax_coverage_scenario' : 'pass_report_contract_syntax_coverage_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractSyntaxCoverageRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  gateSourceText = '',
  sourceFileIds = [],
  sourceTextsByFileId = {},
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    gateSteps: extractIntegrationGateStepSpecs(gateSourceText),
    sourceFileIds: [...sourceFileIds],
    sourceTextsByFileId: { ...(sourceTextsByFileId || {}) },
  };
}

export function buildReportContractSyntaxCoverageRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  gateSourceText = '',
  sourceFileIds = [],
  sourceTextsByFileId = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractSyntaxCoverageRegressionInput({
    manifest,
    gateSourceText,
    sourceFileIds,
    sourceTextsByFileId,
  });
  const actual = analyzeSyntaxCoverage(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_syntax_coverage',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_VERSION,
    kind: 'ReportContractSyntaxCoverageRegression',
    status: blockers.length ? 'blocked_report_contract_syntax_coverage_regression' : 'pass_report_contract_syntax_coverage_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_SCRIPT_ID,
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
      sourceFileCount: actual.sourceFileCount,
      exporterFileCount: actual.exporterFileCount,
      sourceSyntaxStepCount: actual.sourceSyntaxStepCount,
      exporterSyntaxStepCount: actual.exporterSyntaxStepCount,
      sourceSyntaxArgCount: actual.sourceSyntaxArgCount,
      exporterSyntaxArgCount: actual.exporterSyntaxArgCount,
      sourceBeforeExporterCount: actual.sourceBeforeExporterCount,
      exportStepCount: actual.exportStepCount,
      presentExportStepCount: actual.presentExportStepCount,
      exporterBeforeExportCount: actual.exporterBeforeExportCount,
      cliEntrypointPolicyOk: actual.cliEntrypointPolicyOk,
      cliEntrypointSourceCount: actual.cliEntrypointSourceCount,
      cliEntrypointHelperCount: actual.cliEntrypointHelperCount,
      rawCliEntrypointCount: actual.rawCliEntrypointCount,
      urlPathnamePolicyOk: actual.urlPathnamePolicyOk,
      urlPathnameSourceCount: actual.urlPathnameSourceCount,
      directWritePolicyOk: actual.directWritePolicyOk,
      directWriteSourceCount: actual.directWriteSourceCount,
      allowedDirectWriteSourceCount: actual.allowedDirectWriteSourceCount,
      disallowedDirectWriteSourceCount: actual.disallowedDirectWriteSourceCount,
      filesystemMutationPolicyOk: actual.filesystemMutationPolicyOk,
      filesystemMutationSourceCount: actual.filesystemMutationSourceCount,
      allowedFilesystemMutationSourceCount: actual.allowedFilesystemMutationSourceCount,
      disallowedFilesystemMutationSourceCount: actual.disallowedFilesystemMutationSourceCount,
      childProcessPolicyOk: actual.childProcessPolicyOk,
      childProcessSourceCount: actual.childProcessSourceCount,
      allowedChildProcessSourceCount: actual.allowedChildProcessSourceCount,
      disallowedChildProcessSourceCount: actual.disallowedChildProcessSourceCount,
      childProcessCommandSourceCount: actual.childProcessCommandSourceCount,
      childProcessCommandCount: actual.childProcessCommandCount,
      approvedChildProcessCommandCount: actual.approvedChildProcessCommandCount,
      disallowedChildProcessCommandCount: actual.disallowedChildProcessCommandCount,
      approvedChildProcessArgvCount: actual.approvedChildProcessArgvCount,
      disallowedChildProcessArgvCount: actual.disallowedChildProcessArgvCount,
      approvedChildProcessOptionsCount: actual.approvedChildProcessOptionsCount,
      disallowedChildProcessOptionsCount: actual.disallowedChildProcessOptionsCount,
      childProcessSpawnCount: actual.childProcessSpawnCount,
      approvedChildProcessResultCount: actual.approvedChildProcessResultCount,
      disallowedChildProcessResultCount: actual.disallowedChildProcessResultCount,
      externalBoundaryPolicyOk: actual.externalBoundaryPolicyOk,
      externalBoundarySourceCount: actual.externalBoundarySourceCount,
      networkApiSourceCount: actual.networkApiSourceCount,
      browserAutomationSourceCount: actual.browserAutomationSourceCount,
      processEnvSourceCount: actual.processEnvSourceCount,
      allowedProcessEnvSourceCount: actual.allowedProcessEnvSourceCount,
      disallowedProcessEnvSourceCount: actual.disallowedProcessEnvSourceCount,
      dynamicCodePolicyOk: actual.dynamicCodePolicyOk,
      dynamicCodeSourceCount: actual.dynamicCodeSourceCount,
      dynamicImportSourceCount: actual.dynamicImportSourceCount,
      allowedDynamicImportSourceCount: actual.allowedDynamicImportSourceCount,
      disallowedDynamicImportSourceCount: actual.disallowedDynamicImportSourceCount,
      unsafeDynamicCodeSourceCount: actual.unsafeDynamicCodeSourceCount,
      randomnessCryptoPolicyOk: actual.randomnessCryptoPolicyOk,
      randomnessCryptoSourceCount: actual.randomnessCryptoSourceCount,
      cryptoSourceCount: actual.cryptoSourceCount,
      allowedCryptoSourceCount: actual.allowedCryptoSourceCount,
      disallowedCryptoSourceCount: actual.disallowedCryptoSourceCount,
      randomnessSourceCount: actual.randomnessSourceCount,
      runtimeSideEffectPolicyOk: actual.runtimeSideEffectPolicyOk,
      runtimeSideEffectSourceCount: actual.runtimeSideEffectSourceCount,
      directProcessExitSourceCount: actual.directProcessExitSourceCount,
      allowedDirectProcessExitSourceCount: actual.allowedDirectProcessExitSourceCount,
      disallowedDirectProcessExitSourceCount: actual.disallowedDirectProcessExitSourceCount,
      processEnvMutationSourceCount: actual.processEnvMutationSourceCount,
      asyncTimerSourceCount: actual.asyncTimerSourceCount,
      commandStringPolicyOk: actual.commandStringPolicyOk,
      commandStringSourceCount: actual.commandStringSourceCount,
      destructiveCommandStringSourceCount: actual.destructiveCommandStringSourceCount,
      externalCommandStringSourceCount: actual.externalCommandStringSourceCount,
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
  const contractSyntaxCoverageRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    fixture: report.fixture,
    actual: report.actual,
    cliEntrypointSources: actual.cliEntrypointSources,
    urlPathnameSources: actual.urlPathnameSources,
    directWriteSources: actual.directWriteSources,
    filesystemMutationSources: actual.filesystemMutationSources,
    childProcessSources: actual.childProcessSources,
    externalBoundarySources: actual.externalBoundarySources,
    dynamicCodeSources: actual.dynamicCodeSources,
    randomnessCryptoSources: actual.randomnessCryptoSources,
    runtimeSideEffectSources: actual.runtimeSideEffectSources,
    commandStringSources: actual.commandStringSources,
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
    contractSyntaxCoverageRegressionHash,
    hash: contractSyntaxCoverageRegressionHash,
  };
}

export function summarizeReportContractSyntaxCoverageRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_contract_syntax_coverage_regression',
    ok: report?.ok === true,
    contractSyntaxCoverageRegressionHash: report?.contractSyntaxCoverageRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    okContractCount: report?.summary?.okContractCount || 0,
    sourceFileCount: report?.summary?.sourceFileCount || 0,
    exporterFileCount: report?.summary?.exporterFileCount || 0,
    sourceSyntaxStepCount: report?.summary?.sourceSyntaxStepCount || 0,
    exporterSyntaxStepCount: report?.summary?.exporterSyntaxStepCount || 0,
    sourceSyntaxArgCount: report?.summary?.sourceSyntaxArgCount || 0,
    exporterSyntaxArgCount: report?.summary?.exporterSyntaxArgCount || 0,
    sourceBeforeExporterCount: report?.summary?.sourceBeforeExporterCount || 0,
    exportStepCount: report?.summary?.exportStepCount || 0,
    presentExportStepCount: report?.summary?.presentExportStepCount || 0,
    exporterBeforeExportCount: report?.summary?.exporterBeforeExportCount || 0,
    cliEntrypointPolicyOk: report?.summary?.cliEntrypointPolicyOk === true,
    cliEntrypointSourceCount: report?.summary?.cliEntrypointSourceCount || 0,
    cliEntrypointHelperCount: report?.summary?.cliEntrypointHelperCount || 0,
    rawCliEntrypointCount: report?.summary?.rawCliEntrypointCount || 0,
    urlPathnamePolicyOk: report?.summary?.urlPathnamePolicyOk === true,
    urlPathnameSourceCount: report?.summary?.urlPathnameSourceCount || 0,
    directWritePolicyOk: report?.summary?.directWritePolicyOk === true,
    directWriteSourceCount: report?.summary?.directWriteSourceCount || 0,
    allowedDirectWriteSourceCount: report?.summary?.allowedDirectWriteSourceCount || 0,
    disallowedDirectWriteSourceCount: report?.summary?.disallowedDirectWriteSourceCount || 0,
    filesystemMutationPolicyOk: report?.summary?.filesystemMutationPolicyOk === true,
    filesystemMutationSourceCount: report?.summary?.filesystemMutationSourceCount || 0,
    allowedFilesystemMutationSourceCount: report?.summary?.allowedFilesystemMutationSourceCount || 0,
    disallowedFilesystemMutationSourceCount: report?.summary?.disallowedFilesystemMutationSourceCount || 0,
    childProcessPolicyOk: report?.summary?.childProcessPolicyOk === true,
    childProcessSourceCount: report?.summary?.childProcessSourceCount || 0,
    allowedChildProcessSourceCount: report?.summary?.allowedChildProcessSourceCount || 0,
    disallowedChildProcessSourceCount: report?.summary?.disallowedChildProcessSourceCount || 0,
    childProcessCommandSourceCount: report?.summary?.childProcessCommandSourceCount || 0,
    childProcessCommandCount: report?.summary?.childProcessCommandCount || 0,
    approvedChildProcessCommandCount: report?.summary?.approvedChildProcessCommandCount || 0,
    disallowedChildProcessCommandCount: report?.summary?.disallowedChildProcessCommandCount || 0,
    approvedChildProcessArgvCount: report?.summary?.approvedChildProcessArgvCount || 0,
    disallowedChildProcessArgvCount: report?.summary?.disallowedChildProcessArgvCount || 0,
    approvedChildProcessOptionsCount: report?.summary?.approvedChildProcessOptionsCount || 0,
    disallowedChildProcessOptionsCount: report?.summary?.disallowedChildProcessOptionsCount || 0,
    childProcessSpawnCount: report?.summary?.childProcessSpawnCount || 0,
    approvedChildProcessResultCount: report?.summary?.approvedChildProcessResultCount || 0,
    disallowedChildProcessResultCount: report?.summary?.disallowedChildProcessResultCount || 0,
    externalBoundaryPolicyOk: report?.summary?.externalBoundaryPolicyOk === true,
    externalBoundarySourceCount: report?.summary?.externalBoundarySourceCount || 0,
    networkApiSourceCount: report?.summary?.networkApiSourceCount || 0,
    browserAutomationSourceCount: report?.summary?.browserAutomationSourceCount || 0,
    processEnvSourceCount: report?.summary?.processEnvSourceCount || 0,
    allowedProcessEnvSourceCount: report?.summary?.allowedProcessEnvSourceCount || 0,
    disallowedProcessEnvSourceCount: report?.summary?.disallowedProcessEnvSourceCount || 0,
    dynamicCodePolicyOk: report?.summary?.dynamicCodePolicyOk === true,
    dynamicCodeSourceCount: report?.summary?.dynamicCodeSourceCount || 0,
    dynamicImportSourceCount: report?.summary?.dynamicImportSourceCount || 0,
    allowedDynamicImportSourceCount: report?.summary?.allowedDynamicImportSourceCount || 0,
    disallowedDynamicImportSourceCount: report?.summary?.disallowedDynamicImportSourceCount || 0,
    unsafeDynamicCodeSourceCount: report?.summary?.unsafeDynamicCodeSourceCount || 0,
    randomnessCryptoPolicyOk: report?.summary?.randomnessCryptoPolicyOk === true,
    randomnessCryptoSourceCount: report?.summary?.randomnessCryptoSourceCount || 0,
    cryptoSourceCount: report?.summary?.cryptoSourceCount || 0,
    allowedCryptoSourceCount: report?.summary?.allowedCryptoSourceCount || 0,
    disallowedCryptoSourceCount: report?.summary?.disallowedCryptoSourceCount || 0,
    randomnessSourceCount: report?.summary?.randomnessSourceCount || 0,
    runtimeSideEffectPolicyOk: report?.summary?.runtimeSideEffectPolicyOk === true,
    runtimeSideEffectSourceCount: report?.summary?.runtimeSideEffectSourceCount || 0,
    directProcessExitSourceCount: report?.summary?.directProcessExitSourceCount || 0,
    allowedDirectProcessExitSourceCount: report?.summary?.allowedDirectProcessExitSourceCount || 0,
    disallowedDirectProcessExitSourceCount: report?.summary?.disallowedDirectProcessExitSourceCount || 0,
    processEnvMutationSourceCount: report?.summary?.processEnvMutationSourceCount || 0,
    asyncTimerSourceCount: report?.summary?.asyncTimerSourceCount || 0,
    commandStringPolicyOk: report?.summary?.commandStringPolicyOk === true,
    commandStringSourceCount: report?.summary?.commandStringSourceCount || 0,
    destructiveCommandStringSourceCount: report?.summary?.destructiveCommandStringSourceCount || 0,
    externalCommandStringSourceCount: report?.summary?.externalCommandStringSourceCount || 0,
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
