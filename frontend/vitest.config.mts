import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Next tsconfig sets jsx:"preserve"; override it so the transformer (oxc,
  // via rolldown-vite) actually compiles JSX in component tests — e.g.
  // tests/voiceMode.test.ts, which opts into a DOM via `// @vitest-environment
  // happy-dom`. Harmless for the pure-logic .ts suites, which contain no JSX.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Pure-logic suites in src/lib/* run in the default 'node' environment to
    // stay fast; DOM-dependent suites opt in per-file with a `@vitest-environment`
    // comment (happy-dom — jsdom v29 pulls an ESM-only dep that Node 20 can't require()).
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
