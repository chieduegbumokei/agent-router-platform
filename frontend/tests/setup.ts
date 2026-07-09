// Test setup: provide the handful of browser globals our pure-logic tests rely
// on, without pulling in a full DOM implementation (jsdom). Node 20 already
// supplies fetch/Response/btoa; only Web Storage is missing.
import { beforeEach } from 'vitest';

// A minimal, spec-faithful Web Storage: stored items are exposed as enumerable
// own properties (so `Object.keys(localStorage)` works), while the Storage
// methods live behind a Proxy that never shadows the backing data.
function createStorage(): Storage {
  const data: Record<string, string> = Object.create(null);
  const api: Record<string, unknown> = {
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = String(value);
    },
    removeItem: (key: string) => {
      delete data[key];
    },
    clear: () => {
      for (const key of Object.keys(data)) delete data[key];
    },
    key: (index: number) => Object.keys(data)[index] ?? null,
  };

  return new Proxy(data, {
    get(target, prop: string) {
      if (prop === 'length') return Object.keys(target).length;
      if (prop in api) return api[prop];
      return prop in target ? target[prop] : undefined;
    },
    has(target, prop: string) {
      return prop in target;
    },
  }) as unknown as Storage;
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createStorage(),
    writable: true,
    configurable: true,
  });
}

// Each test starts from a clean storage regardless of ordering.
beforeEach(() => globalThis.localStorage.clear());
