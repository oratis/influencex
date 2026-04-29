import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest config for client-side component tests. Kept separate from
// vite.config.js so the production build doesn't try to evaluate testing
// dependencies. Run with `npx vitest --config vitest.config.js`.
//
// Sprint Q2 task C2 — covers the critical interactive components first
// (PasswordInput, OnboardingTour, CommandPalette, FormField). Page-level
// integration tests live elsewhere (Playwright, eventually).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
