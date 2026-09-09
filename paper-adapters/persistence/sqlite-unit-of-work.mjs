import { assertStorePort } from '../../paper-ports/store-port.mjs';
import { assertUnitOfWorkPort } from '../../paper-ports/unit-of-work-port.mjs';

function createRepositories(factories, transactionStore) {
  return Object.freeze(Object.fromEntries(Object.entries(factories).map(([name, factory]) => {
    if (typeof factory !== 'function') throw new Error(`UnitOfWork repository factory ${name} is invalid`);
    const repository = factory(transactionStore);
    if (!repository || typeof repository !== 'object') throw new Error(`UnitOfWork repository ${name} is invalid`);
    return [name, repository];
  })));
}

export function createSqliteUnitOfWork({ store, repositoryFactories = {} } = {}) {
  const ownedStore = assertStorePort(store);
  const factories = Object.freeze({ ...repositoryFactories });
  let active = false;
  return assertUnitOfWorkPort(Object.freeze({
    version: 1,
    kind: 'SqliteUnitOfWorkAdapter',
    available: typeof ownedStore.transaction === 'function',
    run(work, { readOnly = false } = {}) {
      if (typeof work !== 'function') throw new Error('UnitOfWorkPort.run callback is required');
      if (typeof ownedStore.transaction !== 'function') throw new Error('UnitOfWork requires a transactional StorePort');
      if (active) throw new Error('sqlite_nested_unit_of_work_forbidden');
      active = true;
      try {
        return ownedStore.transaction((transactionStore) => work(Object.freeze({
          repositories: createRepositories(factories, transactionStore),
        })), { readOnly: Boolean(readOnly) });
      } finally {
        active = false;
      }
    },
  }));
}
