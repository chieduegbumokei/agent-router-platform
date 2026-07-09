import { config } from '../core/config';
import { createDynamoStore } from './dynamo';
import { createMemoryStore } from './memory';
import type { Store } from './types';

let instance: Store | null = null;

export function getStore(): Store {
  if (!instance) {
    instance = config.store === 'dynamo' ? createDynamoStore() : createMemoryStore();
  }
  return instance;
}

/** Test hook: swap the store (e.g. a fresh memory store per test). */
export function setStore(store: Store): void {
  instance = store;
}

export type { Store } from './types';
