import '@testing-library/jest-dom/vitest';

// localStorage mock — jsdom has one, but we sometimes want to spy.
// Polyfill `useId` quirks if needed (React 18 supports it natively).
