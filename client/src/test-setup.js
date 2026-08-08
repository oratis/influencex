import '@testing-library/jest-dom/vitest';

// localStorage mock — jsdom has one, but we sometimes want to spy.
// Polyfill `useId` quirks if needed (React 18 supports it natively).

// Node >= 22 ships an experimental global `localStorage` accessor that
// evaluates to undefined unless the process is started with
// --localstorage-file — and in vitest's jsdom environment `window` IS
// `globalThis`, so that accessor shadows any storage jsdom would provide.
// Anything calling localStorage.getItem()/clear() (the app does, a lot)
// explodes. Install a plain in-memory Storage polyfill when the global is
// missing or unusable.
if (!globalThis.localStorage) {
  const makeStorage = () => {
    let store = new Map();
    return {
      getItem: k => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => { store.set(String(k), String(v)); },
      removeItem: k => { store.delete(String(k)); },
      clear: () => { store = new Map(); },
      key: i => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: makeStorage(),
    configurable: true,
    writable: true,
  });
  if (!globalThis.sessionStorage) {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: makeStorage(),
      configurable: true,
      writable: true,
    });
  }
}
