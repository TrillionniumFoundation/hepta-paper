// Development differential fixtures only; these keys never grant host authority.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  composeRuntimeImageReproducibilityRequest,
  composeRuntimeImageReproducibilityStatus,
  composeRuntimeImageReproducibilityVerification,
} from '../../paper-composition/automation/runtime-image-reproducibility-composition.mjs';
import {verifyRRuntimeSourceCas} from '../../paper-adapters/automation/r-runtime-source-cas.mjs';
import {readRuntimeImageReproducibilityProcessConfiguration} from '../../paper-adapters/automation/runtime-image-reproducibility-process-identity.mjs';

const input = JSON.parse(process.argv[2]);
if (input.operation === 'configure-fixture') {
  const root = fs.realpathSync(input.root);
  if (!root.startsWith(path.join(os.tmpdir(), 'hepta-runtime-image-rust-'))) {
    throw Error('isolated_fixture_required');
  }
  if (input.builtinThree === true) {
    const repository = path.resolve(import.meta.dirname, '../..');
    const workspace = fs.realpathSync(input.setup.root);
    if (workspace !== path.join(root, 'workspace')) throw Error('isolated_workspace_required');
    const raw = JSON.parse(fs.readFileSync(path.join(repository,
      'rust/crates/hepta-paper-service/src/runtime_image_reproducibility/plugin-inputs.v1.json'), 'utf8'));
    fs.cpSync(path.join(repository, 'runtime-images/r-scientific'),
      path.join(workspace, 'runtime-images/r-scientific'), {recursive: true, errorOnExist: true, force: false});
    for (const sourcePath of Object.keys(raw.sourceHashes)) {
      const target = path.join(workspace, sourcePath);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.copyFileSync(path.join(repository, sourcePath), target, fs.constants.COPYFILE_EXCL);
    }
  }
  for (let index = 1; index <= 2; index += 1) {
    const executable = path.join(root, `live-verifier-${index}.mjs`);
    let source = fs.readFileSync(executable, 'utf8');
    if (input.reverseResponseWire === true) {
      const from = 'process.stdout.write(JSON.stringify(response(';
      if (!source.includes(from)) throw Error('fixture_response_source_drift');
      source = source.replace(from, 'process.stdout.write(responseWire(response(');
      source += `\nfunction responseWire(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).reverse()):item);}`;
    }
    const marker = JSON.stringify(path.join(root, `started-${index}.json`));
    const insertion = input.sleep === true
      ? `fs.writeFileSync(${marker},JSON.stringify({pid:process.pid,ppid:process.ppid}));await new Promise(resolve=>setTimeout(resolve,30000));`
      : 'const ActualDate=Date;globalThis.Date=class extends ActualDate{constructor(...args){super(...(args.length?args:[request.requestedAt]));}};';
    if (!source.includes('const request=JSON.parse(text);')) throw Error('fixture_source_drift');
    fs.writeFileSync(executable, source.replace('const request=JSON.parse(text);', `const request=JSON.parse(text);${insertion}`));
  }
  const environment = {...input.setup.environment};
  delete environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH;
  const loaded = readRuntimeImageReproducibilityProcessConfiguration({
    configPath: input.setup.configPath, environment,
  });
  environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH = loaded.configurationIdentityHash;
  loaded.verifierTrust.forEach((verifier, index) => {
    fs.writeFileSync(path.join(root, `service-${index + 1}.json`), JSON.stringify(verifier), {mode: 0o600});
  });
  process.stdout.write(JSON.stringify({...input.setup, environment}));
} else if (input.operation === 'source-cas') {
  process.stdout.write(JSON.stringify(verifyRRuntimeSourceCas({contextPath:path.join(input.root, 'runtime-images/r-scientific')})));
} else if (input.operation === 'compose') {
  let index = 0;
  const options = {
    ...input.options,
    clock: {now: () => input.statusInspection ? new Date(Date.parse(input.statusInspection.expiresAt) - input.statusInspection.remainingValidityMs) : new Date(input.clocks[Math.min(index++, input.clocks.length - 1)])},
    randomUUID: () => input.nonce.replace(/^runtime-repro:/, ''),
  };
  let value;
  if (options.action === 'request') {
    const generated = composeRuntimeImageReproducibilityRequest(options);
    value = {
      version: 1, kind: 'RuntimeImageReproducibilityRequestReport',
      status: 'runtime_image_reproducibility_request_generated',
      request: generated.request,
      configuration: {
        configurationIdentityHash: generated.context.configuration.configurationIdentityHash,
        trustIdentityHash: generated.context.configuration.trustIdentityHash,
        independentVerifierCount: generated.context.configuration.verifierTrust.length,
        configurationPinned: generated.context.configuration.configurationPinned === true,
        fullProductionReady: generated.context.configurationInspection.fullProductionReady === true,
        privateSigningKeyLoaded: false,
      },
      externalActionPerformed: false,
    };
  } else if (options.action === 'status') {
    value = composeRuntimeImageReproducibilityStatus({...options, now: options.clock.now()});
  } else {
    value = await composeRuntimeImageReproducibilityVerification(options);
  }
  process.stdout.write(JSON.stringify(value));
} else {
  throw Error('unknown_oracle_operation');
}
