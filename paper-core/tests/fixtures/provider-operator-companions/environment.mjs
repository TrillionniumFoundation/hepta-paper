import fs from 'node:fs';
if (process.env.HEPTA_TEST_PRIVATE_CANARY) {
  process.stderr.write(process.env.HEPTA_TEST_PRIVATE_CANARY);
  process.exit(17);
}
const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.writeFileSync(process.argv[3], JSON.stringify({
  dispatchAuthorizationHash: request.dispatchAuthorizationHash,
  providerReceipt: { sandbox: true },
  externalActionPerformed: false,
}));
