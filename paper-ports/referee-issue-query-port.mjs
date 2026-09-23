export function assertRefereeIssueQueryPort(query) {
  for (const method of ['countOpenByPaperId', 'listOpenByPaperId']) {
    if (typeof query?.[method] !== 'function') throw new Error(`RefereeIssueQueryPort.${method} is required`);
  }
  return query;
}
