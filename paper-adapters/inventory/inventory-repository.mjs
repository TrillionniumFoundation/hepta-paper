import { assertInventoryRepositoryPort } from '../../paper-ports/inventory-repository-port.mjs';
import { discoverInventory } from './index.mjs';

export function createInventoryRepository({ store } = {}) {
  if (!store?.query) throw new Error('Inventory repository requires StorePort');
  return Object.freeze(assertInventoryRepositoryPort({
    version: 1,
    kind: 'StoreBackedInventoryRepository',
    discover(options = {}) {
      return discoverInventory({ ...options, store });
    },
  }));
}
