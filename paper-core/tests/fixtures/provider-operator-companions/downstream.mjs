import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.writeFileSync(process.argv[3], JSON.stringify({
  dispatchAuthorizationHash: request.dispatchAuthorizationHash,
  providerReceipt: { sandbox: true },
  externalActionPerformed: false,
}));
