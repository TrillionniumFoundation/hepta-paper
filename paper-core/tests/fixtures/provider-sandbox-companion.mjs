import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const requestPath = process.argv[2];
const outputPath = process.argv[3];
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const mode = request.paperId;

function writeText(value) {
  fs.writeFileSync(outputPath, value);
}

switch (mode) {
  case 'case:valid':
    writeText(JSON.stringify({
      externalActionPerformed: false,
      providerReceipt: { sandbox: true },
      dispatchAuthorizationHash: request.dispatchAuthorizationHash,
    }));
    break;
  case 'case:environment':
    writeText(JSON.stringify({
      keys: Object.keys(process.env).sort(),
      home: process.env.HOME,
      temporary: process.env.TMPDIR,
      cwd: process.cwd(),
    }));
    break;
  case 'case:private-diagnostic':
    process.stderr.write('test-only-private-diagnostic');
    process.exit(17);
    break;
  case 'case:timeout':
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    break;
  case 'case:excessive-output':
    process.stdout.write('x'.repeat(256 * 1024));
    setInterval(() => {}, 1000);
    break;
  case 'case:malformed':
    writeText('{bad');
    break;
  case 'case:scalar':
    writeText('false');
    break;
  case 'case:array-root':
    writeText('[]');
    break;
  case 'case:duplicate-flag':
    writeText('{"externalActionPerformed":true,"externalActionPerformed":false}');
    break;
  case 'case:escaped-duplicate':
    writeText('{"key":1,"k\\u0065y":2}');
    break;
  case 'case:nested-duplicate':
    writeText('{"nested":{"k":1,"k":2}}');
    break;
  case 'case:nonfinite':
    writeText('{"n":1e999}');
    break;
  case 'case:depth':
    writeText('{"nested":' + '['.repeat(32) + '0' + ']'.repeat(32) + '}');
    break;
  case 'case:token-limit':
    writeText('{"many":[' + Array(5000).fill('0').join(',') + ']}');
    break;
  case 'case:byte-limit':
    writeText('x'.repeat(65537));
    break;
  case 'case:escaped-response':
    writeText(JSON.stringify({
      a: [{ key: 1 }, { key: 2 }],
      key: 0,
      s: '"[]{}\\key\\u0011',
      n: -1.5e12,
    }));
    break;
  case 'case:invalid-utf8':
    fs.writeFileSync(outputPath, Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
    break;
  case 'case:missing':
    process.exit(0);
    break;
  case 'case:symlink':
    fs.symlinkSync(requestPath, outputPath);
    break;
  case 'case:hardlink':
    fs.linkSync(requestPath, outputPath);
    break;
  case 'case:fifo': {
    const result = spawnSync('/usr/bin/mkfifo', [outputPath], { stdio: 'ignore' });
    if (result.status !== 0) process.exit(19);
    break;
  }
  case 'case:request-mutation':
    writeText('{}');
    fs.appendFileSync(requestPath, ' ');
    break;
  case 'case:source-mutation':
    writeText('{}');
    fs.appendFileSync(fileURLToPath(import.meta.url), '\n// mutated');
    break;
  case 'case:executed-marker':
    fs.writeFileSync('executed', 'bad');
    break;
  default:
    process.stderr.write('unknown-test-mode');
    process.exit(20);
}
