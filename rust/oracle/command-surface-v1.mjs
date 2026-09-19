import fs from 'node:fs';

import {
  classifyNpmScriptSurface,
  generatedNpmRouteScripts,
  HEPTA_PAPER_COMMAND_REGISTRY,
  heptaPaperCiCommandMatrix,
  inspectNpmScriptRegistry,
} from '../../paper-core/src/command-registry.mjs';

const routedScripts = new Set(Object.values(HEPTA_PAPER_COMMAND_REGISTRY)
  .flatMap((commands) => Object.values(commands).map((command) => command.npmScript).filter(Boolean)));

function run(request) {
  const packagePath = `${request.root}/package.json`;
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (request.writePackage || request.mode === 'write-package') {
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
  switch (request.mode) {
    case 'check-package':
      return inspectNpmScriptRegistry(packageJson.scripts || {});
    case 'npm-aliases':
      return generatedNpmRouteScripts();
    case 'ci-matrix':
      return heptaPaperCiCommandMatrix();
    case 'classify':
      return classifyNpmScriptSurface(Object.keys(packageJson.scripts || {}));
    default:
      return inspectNpmScriptRegistry(packageJson.scripts || {});
  }
}

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results: requests.map((request) => {
    try {
      const value = run(request);
      const check = request.writePackage || ['write-package', 'check-package'].includes(request.mode);
      return {
        ok: true,
        value,
        raw: JSON.stringify(value),
        exitCode: check && !value.ready ? 1 : 0,
      };
    }
    catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  }),
}));
