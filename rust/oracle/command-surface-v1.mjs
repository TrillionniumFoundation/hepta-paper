import fs from 'node:fs';

import {
  generatedNpmRouteScripts,
  HEPTA_PAPER_COMMAND_REGISTRY,
  inspectNpmScriptRegistry,
} from '../../paper-core/src/command-registry.mjs';

const routedScripts = new Set(Object.values(HEPTA_PAPER_COMMAND_REGISTRY)
  .flatMap((commands) => Object.values(commands).map((command) => command.npmScript).filter(Boolean)));

function run(request) {
  const packagePath = `${request.root}/package.json`;
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (request.writePackage) {
    const nextPackage = {
      ...packageJson,
      scripts: {
        ...Object.fromEntries(Object.entries(packageJson.scripts || {})
          .filter(([name]) => !routedScripts.has(name))),
        ...generatedNpmRouteScripts(),
      },
    };
    fs.writeFileSync(packagePath, `${JSON.stringify(nextPackage, null, 2)}\n`, { mode: 0o644 });
    return inspectNpmScriptRegistry(nextPackage.scripts);
  }
  return inspectNpmScriptRegistry(packageJson.scripts || {});
}

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results: requests.map((request) => {
    try {
      const value = run(request);
      return { ok: true, value, raw: JSON.stringify(value) };
    }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }),
}));
