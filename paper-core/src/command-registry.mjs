import {
  HEPTA_PAPER_CI_COMMAND_MATRIX,
  NPM_COMMAND_GROUPS,
  buildNpmCommandClassification,
} from './command-registry-catalog.mjs';
import {
  AUTONOMOUS_RESEARCH_CLI_ARGUMENT_SCHEMA,
  COMMAND_REGISTRY_ROUTES as ROUTES,
} from './command-registry-routes.mjs';

export { AUTONOMOUS_RESEARCH_CLI_ARGUMENT_SCHEMA };

const ROUTE_GROUPS = Object.freeze(['operator', 'maintenance', 'verify', 'retirement']);
export const HEPTA_PAPER_COMMAND_REGISTRY = Object.freeze(Object.fromEntries(ROUTE_GROUPS.map((group) => [
  group,
  Object.freeze(Object.fromEntries(ROUTES
    .filter((entry) => entry.group === group)
    .map((entry) => [entry.name, entry]))),
])));

const NPM_CLASSIFICATION = buildNpmCommandClassification(ROUTES);
const RETAINED_NPM_ROUTE_ALIASES = new Set([
  'coverage:critical-modules',
  'gpu:personal-gate',
  'personal:readiness',
  'legacy:deletion-drill',
  'legacy:reference-verify',
  'migration:capability-matrix-v3',
  'migration:retirement-status',
  'release:trust-gate',
  'release:verify',
  'store:logical-integrity',
  'test',
]);

export function resolveHeptaPaperCommand(group, name) {
  return HEPTA_PAPER_COMMAND_REGISTRY[group]?.[name] || null;
}

export function heptaPaperCommandUsage() {
  return Object.freeze({
    version: 4,
    kind: 'HeptaPaperCommandSurface',
    usage: 'hepta-paper <operator|maintenance|verify|retirement> <command> [-- command-args]',
    groups: Object.freeze(Object.fromEntries(ROUTE_GROUPS.map((group) => [
      group,
      Object.freeze(Object.keys(HEPTA_PAPER_COMMAND_REGISTRY[group])),
    ]))),
    commands: Object.freeze(Object.fromEntries(ROUTE_GROUPS.map((group) => [
      group,
      Object.freeze(Object.fromEntries(Object.entries(HEPTA_PAPER_COMMAND_REGISTRY[group])
        .map(([name, entry]) => [name, Object.freeze({
          argv: entry.argv,
          npmScript: RETAINED_NPM_ROUTE_ALIASES.has(entry.npmScript)
            ? entry.npmScript : null,
          mutability: entry.mutability,
          effects: entry.effects,
        })]))),
    ]))),
    constraints: Object.freeze(ROUTES
      .filter((entry) => entry.unsupportedModes.length)
      .map((entry) => Object.freeze({
        group: entry.group,
        command: entry.name,
        unsupportedModes: entry.unsupportedModes,
        behavior: 'production_batch_fails_closed_use_explicit_compatibility_entrypoint',
      }))),
    compatibility: 'this CLI is the supported command surface; retained npm scripts are verification and release plumbing, not alternate operator entrypoints',
  });
}

export function generatedNpmRouteScripts() {
  return Object.freeze(Object.fromEntries(ROUTES
    .filter((entry) => RETAINED_NPM_ROUTE_ALIASES.has(entry.npmScript))
    .map((entry) => [entry.npmScript, entry.npmCommand || entry.argv.join(' ')])));
}

export function inspectNpmScriptRegistry(packageScripts = {}) {
  const generatedAliases = generatedNpmRouteScripts();
  const aliasMismatches = Object.freeze(Object.entries(generatedAliases).flatMap(
    ([name, command]) => packageScripts[name] === command
      ? [] : [Object.freeze({
        name,
        expected: command,
        actual: packageScripts[name] || null,
      })],
  ));
  const surface = classifyNpmScriptSurface(Object.keys(packageScripts));
  const retained = new Set(Object.keys(generatedAliases));
  const retiredAliases = Object.freeze(ROUTES.map((entry) => entry.npmScript).filter(Boolean)
    .filter((name) => !retained.has(name) && Object.hasOwn(packageScripts, name))
    .sort());
  return Object.freeze({
    version: 2,
    kind: 'NpmScriptRegistryInspection',
    ready: aliasMismatches.length === 0
      && retiredAliases.length === 0
      && surface.blocked.length === 0,
    generatedAliases,
    aliasMismatches,
    retiredAliases,
    blocked: surface.blocked,
  });
}

export function heptaPaperCiCommandMatrix() {
  for (const entries of Object.values(HEPTA_PAPER_CI_COMMAND_MATRIX)) {
    for (const entry of entries) {
      for (const npmScript of entry.npmScripts) {
        if (!NPM_CLASSIFICATION.has(npmScript)) {
          throw new Error(`ci_matrix_npm_script_unregistered:${npmScript}`);
        }
      }
    }
  }
  return HEPTA_PAPER_CI_COMMAND_MATRIX;
}

export function classifyNpmScriptSurface(scriptNames) {
  const groups = Object.fromEntries(NPM_COMMAND_GROUPS.map((group) => [group, []]));
  const blocked = [];
  for (const name of [...scriptNames].sort()) {
    const group = NPM_CLASSIFICATION.get(name);
    if (group) groups[group].push(name);
    else {
      groups.internal.push(name);
      blocked.push(name);
    }
  }
  return Object.freeze({
    version: 4,
    kind: 'NpmCommandSurface',
    policy: 'unregistered scripts default to internal and are blocked from the supported operator surface',
    groups: Object.freeze(Object.fromEntries(Object.entries(groups).map(([group, names]) => [group, Object.freeze(names)]))),
    blocked: Object.freeze(blocked),
  });
}
