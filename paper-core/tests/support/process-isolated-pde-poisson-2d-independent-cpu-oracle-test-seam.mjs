import { registerHooks } from 'node:module';
import { withPdePoisson2dCpuOracleSandboxRunnerForTest } from '../test-doubles/pde-poisson-2d-cpu-oracle-sandbox-runner-factory.mjs';
const ORACLE_MODULE = new URL('../../../paper-adapters/research-verify/process-isolated-pde-poisson-2d-independent-cpu-oracle.mjs', import.meta.url);
const ORACLE_TEST_MODULE = new URL(ORACLE_MODULE.href);
ORACLE_TEST_MODULE.searchParams.set('hepta_test_graph','process-isolated-pde-poisson-2d-cpu-oracle-fixture-v1');
const FACTORY_MODULE = new URL('../../../paper-adapters/research-verify/pde-poisson-2d-cpu-oracle-sandbox-runner-factory.mjs', import.meta.url);
const FACTORY_DOUBLE = new URL('../test-doubles/pde-poisson-2d-cpu-oracle-sandbox-runner-factory.mjs', import.meta.url);
const redirects = new Map([[[ORACLE_TEST_MODULE.href, FACTORY_MODULE.href].join('\n'), FACTORY_DOUBLE.href]]);
registerHooks({ resolve(specifier, context, nextResolve) { const resolved=nextResolve(specifier,context); const replacement=redirects.get([context.parentURL,resolved.url].join('\n')); return replacement?{shortCircuit:true,url:replacement}:resolved; } });
export async function importProcessIsolatedPdePoisson2dIndependentCpuOracleForTest(){ return import(ORACLE_TEST_MODULE.href); }
export { withPdePoisson2dCpuOracleSandboxRunnerForTest };
