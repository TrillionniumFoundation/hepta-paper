import { createSqliteRefereeIssueQuery } from '../../paper-adapters/persistence/sqlite-referee-issue-query.mjs';
import { createSqliteUnitOfWork } from '../../paper-adapters/persistence/sqlite-unit-of-work.mjs';
import { assertRefereeIssueQueryPort } from '../../paper-ports/referee-issue-query-port.mjs';
import { assertUnitOfWorkPort } from '../../paper-ports/unit-of-work-port.mjs';

export function composeTypedPersistenceServices({ store, overrides = {} } = {}) {
  if (!store) throw new Error('typed persistence composition requires StorePort');
  const refereeIssueQuery = assertRefereeIssueQueryPort(
    overrides.refereeIssueQuery || createSqliteRefereeIssueQuery({ store }),
  );
  const unitOfWork = assertUnitOfWorkPort(overrides.unitOfWork || createSqliteUnitOfWork({
    store,
    repositoryFactories: {
      refereeIssues: (transactionStore) => createSqliteRefereeIssueQuery({ store: transactionStore }),
    },
  }));
  return Object.freeze({ refereeIssueQuery, unitOfWork });
}
